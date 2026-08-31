import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MinioService } from '../../common/services/minio.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { SearchMessagesDto } from './dto/search-messages.dto';

/** Convert Prisma appointment (date + hour) to the startTime/endTime shape the client expects. */
function normalizeAppointment(
  apt:
    | { id: number; title: string; date: Date; hour: string; status: string; type: string }
    | null
    | undefined
) {
  if (!apt) return null;
  const dateStr = (apt.date instanceof Date ? apt.date : new Date(apt.date))
    .toISOString()
    .slice(0, 10);
  const parts = (apt.hour ?? '00:00').split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    id: apt.id,
    title: apt.title,
    startTime: `${dateStr}T${pad(h)}:${pad(m)}:00.000Z`,
    endTime: `${dateStr}T${pad((h + 1) % 24)}:${pad(m)}:00.000Z`,
    status: apt.status,
    type: apt.type,
  };
}

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private minioService: MinioService
  ) {}

  // ==================== ROOMS ====================

  /**
   * Ensure a direct chat room exists between two users.
   * Used when creating a new user so they appear immediately in messaging.
   * No-op if the room already exists.
   */
  async createDirectRoomIfNotExists(userAId: number, userBId: number) {
    return this.findOrCreateDirectRoom(userAId, userBId);
  }

  /**
   * Backfill: create all missing direct rooms for a given user.
   * Idempotent — safe to call multiple times.
   * Should be called once per existing user via POST /chat/rooms/backfill,
   * then removed from GET /chat/rooms once all users are migrated.
   */
  async backfillDirectRooms(userId: number): Promise<{ created: number; skipped: number }> {
    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true, role: { select: { code: true } } },
    });

    if (!currentUser?.companyId) return { created: 0, skipped: 0 };

    const potentialContactIds: number[] = [];

    if (currentUser.role?.code === 'ACCOUNTANT') {
      // Clients from active relationships
      const relationships = await this.prisma.clientAccountingFirmRelationship.findMany({
        where: { accountingFirmId: currentUser.companyId, status: 'active' },
        include: {
          clientCompany: {
            select: {
              employees: { select: { id: true }, where: { role: { code: 'CLIENT' } } },
            },
          },
        },
      });
      potentialContactIds.push(
        ...relationships.flatMap((r) => r.clientCompany.employees.map((e) => e.id))
      );

      // Collaborators from same company
      const collabs = await this.prisma.user.findMany({
        where: {
          companyId: currentUser.companyId,
          id: { not: userId },
          role: { code: { in: ['COLLABORATOR', 'COLLABORATEUR'] } },
        },
        select: { id: true },
      });
      potentialContactIds.push(...collabs.map((c) => c.id));
    } else if (currentUser.role?.code === 'CLIENT') {
      const relationships = await this.prisma.clientAccountingFirmRelationship.findMany({
        where: { clientCompanyId: currentUser.companyId, status: 'active' },
        include: {
          accountingFirm: {
            select: {
              employees: { select: { id: true }, where: { role: { code: 'ACCOUNTANT' } } },
            },
          },
        },
      });
      potentialContactIds.push(
        ...relationships.flatMap((r) => r.accountingFirm.employees.map((e) => e.id))
      );
    } else {
      // Collaborator — get accountants from same company
      const accountants = await this.prisma.user.findMany({
        where: {
          companyId: currentUser.companyId,
          id: { not: userId },
          role: { code: 'ACCOUNTANT' },
        },
        select: { id: true },
      });
      potentialContactIds.push(...accountants.map((a) => a.id));
    }

    if (potentialContactIds.length === 0) return { created: 0, skipped: 0 };

    // Find which contacts already have a direct room
    const existingRooms = await this.prisma.chatRoom.findMany({
      where: {
        type: 'direct',
        status: 'active',
        participants: { has: String(userId) },
      },
      select: { participants: true },
    });
    const existingPartners = new Set(
      existingRooms.flatMap((r) => r.participants.map(Number).filter((id) => id !== userId))
    );

    const missing = [...new Set(potentialContactIds)].filter((id) => !existingPartners.has(id));

    let created = 0;
    for (const contactId of missing) {
      try {
        await this.findOrCreateDirectRoom(userId, contactId);
        created++;
      } catch {
        // Error creating direct room
      }
    }

    return { created, skipped: existingPartners.size };
  }

  /**
   * Find or create a direct (1-on-1) chat room between two users.
   * Returns existing room if found, otherwise creates a new one.
   */
  async findOrCreateDirectRoom(userId: number, targetUserId: number) {
    // Check if a direct room already exists between these two users
    const existingRoom = await this.prisma.chatRoom.findFirst({
      where: {
        type: 'direct',
        status: 'active',
        AND: [
          { participants: { has: String(userId) } },
          { participants: { has: String(targetUserId) } },
        ],
      },
      include: {
        createdBy: {
          select: { id: true, username: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    if (existingRoom) {
      // Enrich with participant profiles
      const participantIds = existingRoom.participants.map(Number).filter((id) => id !== userId);
      const profiles = await this.prisma.user.findMany({
        where: { id: { in: participantIds } },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          email: true,
          company: { select: { id: true, name: true } },
          role: { select: { nameFr: true, code: true } },
        },
      });

      return {
        ...existingRoom,
        participantProfiles: profiles,
        lastMessage: null,
        unreadCount: 0,
      };
    }

    // Create new direct room
    const newRoom = await this.prisma.chatRoom.create({
      data: {
        type: 'direct',
        participants: [String(userId), String(targetUserId)],
        createdById: userId,
        status: 'active',
      },
      include: {
        createdBy: {
          select: { id: true, username: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    // Enrich with participant profiles
    const profiles = await this.prisma.user.findMany({
      where: { id: targetUserId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        email: true,
        company: { select: { id: true, name: true } },
        role: { select: { nameFr: true, code: true } },
      },
    });

    return {
      ...newRoom,
      participantProfiles: profiles,
      lastMessage: null,
      unreadCount: 0,
    };
  }

  async createRoom(userId: number, dto: CreateRoomDto) {
    // Dédupliquer et s'assurer que le créateur est dans les participants
    const uniqueParticipants = [...new Set([...dto.participants.map(Number), userId])];

    const room = await this.prisma.chatRoom.create({
      data: {
        name: dto.name,
        type: dto.type,
        description: dto.description,
        participants: uniqueParticipants.map(String),
        createdById: userId,
        contextId: dto.contextId,
        contextType: dto.contextType,
        admins: [String(userId)],
      },
      include: {
        createdBy: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    return room;
  }

  async getRoomById(roomId: number, userId: number) {
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId },
      include: {
        createdBy: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (!room) {
      throw new NotFoundException('Salle de chat introuvable');
    }

    // Vérifier que l'utilisateur est participant
    if (!room.participants.includes(String(userId))) {
      throw new ForbiddenException("Vous n'êtes pas participant de cette salle");
    }

    return room;
  }

  async getUserRoomsDebug(
    userId: number,
    category?: string,
    search?: string,
    date?: string,
    page: number = 1,
    pageSize: number = 50,
    categories?: string[],
    unreadOnly?: boolean
  ) {
    // Get user info to determine what potential contacts they have
    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        companyId: true,
        role: { select: { code: true } },
      },
    });

    // Use categories array if provided, otherwise fallback to single category for backwards compatibility
    const categoriesToFilter = categories || (category ? [category] : undefined);

    // Determine room type filter from categories BEFORE hitting the DB.
    // "group" in categories → include group rooms
    // other categories → include direct rooms
    // no categories → all rooms
    let roomTypeFilter: string | string[] | undefined;
    if (categoriesToFilter && categoriesToFilter.length > 0) {
      const hasGroup = categoriesToFilter.some((c) => c.toLowerCase() === 'group');
      const hasOther = categoriesToFilter.some((c) => c.toLowerCase() !== 'group');

      if (hasGroup && hasOther) {
        roomTypeFilter = ['group', 'direct']; // Include both types
      } else if (hasGroup) {
        roomTypeFilter = 'group';
      } else {
        roomTypeFilter = 'direct';
      }
    }

    // Build where clause with type filter
    const whereClause: any = {
      participants: { has: String(userId) },
      status: 'active',
    };

    // Add type filter if provided
    if (roomTypeFilter) {
      if (Array.isArray(roomTypeFilter)) {
        whereClause.type = { in: roomTypeFilter };
      } else {
        whereClause.type = roomTypeFilter;
      }
    }

    // Get existing chat rooms — filtered by type at DB level
    // Note: We fetch all rooms first to apply category and search filters in-memory
    // since these depend on participant profile data. Pagination applied after filtering.
    const matchedRooms = await this.prisma.chatRoom.findMany({
      where: whereClause,
      include: {
        createdBy: {
          select: { id: true, username: true, email: true, firstName: true, lastName: true },
        },
      },
      orderBy: { lastActivity: 'desc' },
    });

    // Enrich with participant profiles
    const allParticipantIds = [
      ...new Set(
        matchedRooms.flatMap((r) => r.participants.map(Number).filter((id) => id !== userId))
      ),
    ];

    // Get all potential contacts based on role
    const potentialContactIds: number[] = [];

    // If comptable/accountant, get all clients from active relationships
    if (currentUser?.role?.code === 'ACCOUNTANT' && currentUser.companyId) {
      const relationships = await this.prisma.clientAccountingFirmRelationship.findMany({
        where: {
          accountingFirmId: currentUser.companyId,
          status: 'active',
        },
        include: {
          clientCompany: {
            select: {
              employees: {
                select: { id: true },
                where: {
                  role: { code: 'CLIENT' },
                },
              },
            },
          },
        },
      });

      const clientIds = relationships.flatMap((rel) =>
        rel.clientCompany.employees.map((emp) => emp.id)
      );
      potentialContactIds.push(...clientIds);

      // Also get collaborators from same company
      const collaborators = await this.prisma.user.findMany({
        where: {
          companyId: currentUser.companyId,
          id: { not: userId },
          role: { code: { in: ['COLLABORATOR', 'COLLABORATEUR'] } },
        },
        select: { id: true },
      });
      potentialContactIds.push(...collaborators.map((c) => c.id));
    }
    // If client, get their accountant and collaborators
    else if (currentUser?.role?.code === 'CLIENT' && currentUser.companyId) {
      const relationships = await this.prisma.clientAccountingFirmRelationship.findMany({
        where: {
          clientCompanyId: currentUser.companyId,
          status: 'active',
        },
        include: {
          accountingFirm: {
            select: {
              employees: {
                select: { id: true },
                where: {
                  role: { code: 'ACCOUNTANT' },
                },
              },
            },
          },
        },
      });

      const accountantIds = relationships.flatMap((rel) =>
        rel.accountingFirm.employees.map((emp) => emp.id)
      );
      potentialContactIds.push(...accountantIds);
    }
    // If collaborator, get accountants from same company
    else if (currentUser?.companyId) {
      const colleagues = await this.prisma.user.findMany({
        where: {
          companyId: currentUser.companyId,
          id: { not: userId },
          role: { code: 'ACCOUNTANT' },
        },
        select: { id: true },
      });
      potentialContactIds.push(...colleagues.map((c) => c.id));
    }

    // Build the full list of user IDs to fetch profiles for.
    // Only includes participants of real persisted rooms — GET is read-only.
    const allUserIds = [...new Set([...allParticipantIds, ...potentialContactIds])];

    const profiles = allUserIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: allUserIds } },
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            email: true,
            company: { select: { id: true, name: true } },
            role: { select: { nameFr: true, code: true } },
          },
        })
      : [];

    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    const lastMessageIds = matchedRooms
      .map((r) => r.lastMessageId)
      .filter((id): id is number => typeof id === 'number' && id > 0);

    const lastMessages = lastMessageIds.length
      ? await this.prisma.chatMessage.findMany({
          where: { id: { in: lastMessageIds } },
          select: {
            id: true,
            roomId: true,
            content: true,
            type: true,
            senderId: true,
            createdAt: true,
          },
        })
      : [];

    const lastMessageMap = new Map(lastMessages.map((m) => [m.roomId, m]));

    // For rooms without a lastMessageId (old data created before tracking was added),
    // fall back to fetching the actual most recent message from the DB.
    const roomsNeedingFallback = matchedRooms
      .filter((r) => !r.lastMessageId && !lastMessageMap.has(r.id))
      .map((r) => r.id);

    if (roomsNeedingFallback.length) {
      const fallbackMessages = await this.prisma.chatMessage.findMany({
        where: { roomId: { in: roomsNeedingFallback }, deleted: false },
        orderBy: { createdAt: 'desc' },
        distinct: ['roomId'],
        select: {
          id: true,
          roomId: true,
          content: true,
          type: true,
          senderId: true,
          createdAt: true,
        },
      });
      for (const msg of fallbackMessages) {
        lastMessageMap.set(msg.roomId, msg);
      }
    }

    // Count unread messages per room: sent by someone else AND not yet in readBy for this user
    const unreadCounts = matchedRooms.length
      ? await this.prisma.chatMessage.groupBy({
          by: ['roomId'],
          where: {
            roomId: { in: matchedRooms.map((r) => r.id) },
            deleted: false,
            senderId: { not: userId },
            NOT: { readBy: { has: String(userId) } },
          },
          _count: { id: true },
        })
      : [];

    const unreadMap = new Map(unreadCounts.map((u) => [u.roomId, u._count.id]));

    const enriched = matchedRooms.map((room) => {
      const roomProfiles = room.participants
        .map(Number)
        .filter((id) => id !== userId)
        .map((id) => profileMap.get(id) ?? null)
        .filter(Boolean);

      return {
        ...room,
        participantProfiles: roomProfiles,
        lastMessage: lastMessageMap.get(room.id) ?? null,
        unreadCount: unreadMap.get(room.id) ?? 0,
      };
    });

    // Return only real persisted rooms — no virtual/synthetic rooms.
    // Virtual rooms (negative IDs) were removed because they cause cache corruption,
    // socket join failures, and UI instability. The frontend handles new conversations
    // by calling POST /chat/rooms/direct when the user initiates a chat.
    const allRooms = enriched;

    // Map a requested category string to the set of role codes it covers.
    // Handles spelling variants (COLLABORATOR vs COLLABORATEUR, COMPTABLE vs ACCOUNTANT)
    // and case differences coming from different DB seeds or backends.
    function categoryMatchesRoleCode(cat: string, roleCode: string): boolean {
      const c = cat.toLowerCase();
      const r = roleCode.toLowerCase();
      if (c === 'client') return r === 'client' || r.startsWith('client_');
      if (c === 'collaborateur') return r === 'collaborateur' || r === 'collaborator';
      if (c === 'comptable') return r === 'comptable' || r === 'accountant';
      // Fallback: exact match
      return r === c;
    }

    // Apply category filter with OR logic: keep rooms where at least one other participant
    // has a role.code that belongs to ANY of the requested categories.
    // Runs after profile enrichment because role data lives on users, not rooms.
    let filtered =
      categoriesToFilter && categoriesToFilter.length > 0
        ? allRooms.filter((room) => {
            const isGroupRoom = room.type === 'group';

            // Check if any category matches this room
            return categoriesToFilter.some((cat) => {
              const catLower = cat.toLowerCase();

              // Group rooms match "group" category
              if (catLower === 'group') {
                return isGroupRoom;
              }

              // Direct rooms match role-based categories
              if (!isGroupRoom) {
                return room.participantProfiles.some(
                  (p: any) => p?.role?.code && categoryMatchesRoleCode(cat, p.role.code)
                );
              }

              return false;
            });
          })
        : allRooms;

    // Apply search filter: keep rooms whose own name matches (groups) OR
    // where at least one other participant has a name, username or email
    // that contains the search term (unchanged behavior for direct rooms).
    if (search) {
      const term = search.trim().toLowerCase();
      filtered = filtered.filter((room) => {
        const nameMatch = (room.name ?? '').toLowerCase().includes(term);
        const participantMatch = room.participantProfiles.some((p: any) => {
          const fullName = [p?.firstName, p?.lastName].filter(Boolean).join(' ').toLowerCase();
          const username = (p?.username ?? '').toLowerCase();
          const email = (p?.email ?? '').toLowerCase();
          return fullName.includes(term) || username.includes(term) || email.includes(term);
        });
        return nameMatch || participantMatch;
      });
    }

    // Apply date filter: keep only rooms whose lastActivity falls on the given date (UTC).
    // date is expected as YYYY-MM-DD.
    if (date) {
      filtered = filtered.filter((room) => {
        if (!room.lastActivity) return false;
        return new Date(room.lastActivity).toISOString().slice(0, 10) === date;
      });
    }

    // Apply unread filter: keep only rooms with unread messages
    if (unreadOnly) {
      filtered = filtered.filter((room) => room.unreadCount > 0);
    }

    // Calculate pagination
    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize);
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    // Apply pagination to filtered results
    const paginated = filtered.slice(skip, skip + take);

    // Return paginated shape expected by frontend
    return {
      data: paginated,
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  async getUserRooms(userId: number) {
    const rooms = await this.prisma.chatRoom.findMany({
      where: {
        participants: {
          has: String(userId),
        },
        status: 'active',
      },
      include: {
        createdBy: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        lastActivity: 'desc',
      },
    });

    return rooms;
  }

  async updateRoom(roomId: number, userId: number, data: { name?: string }) {
    const room = await this.getRoomById(roomId, userId);

    if (!room.admins.includes(String(userId))) {
      throw new ForbiddenException('Seuls les admins peuvent modifier ce groupe');
    }

    const updated = await this.prisma.chatRoom.update({
      where: { id: roomId },
      data: { ...(data.name !== undefined && { name: data.name }) },
    });

    return updated;
  }

  async addParticipant(roomId: number, userId: number, participantId: number) {
    const room = await this.getRoomById(roomId, userId);

    // Vérifier que l'utilisateur est admin
    if (!room.admins.includes(String(userId))) {
      throw new ForbiddenException('Seuls les admins peuvent ajouter des participants');
    }

    // Ajouter le participant
    if (!room.participants.includes(String(participantId))) {
      await this.prisma.chatRoom.update({
        where: { id: roomId },
        data: {
          participants: {
            push: String(participantId),
          },
        },
      });
    }

    return { message: 'Participant ajouté avec succès' };
  }

  async removeParticipant(roomId: number, userId: number, participantId: number) {
    const room = await this.getRoomById(roomId, userId);

    // Vérifier que l'utilisateur est admin
    if (!room.admins.includes(String(userId))) {
      throw new ForbiddenException('Seuls les admins peuvent retirer des participants');
    }

    // Empêcher un admin de se retirer lui-même
    if (userId === participantId) {
      throw new ForbiddenException('Un admin ne peut pas se retirer lui-même de la salle');
    }

    // Synchroniser admins[] : retirer participantId des admins s'il y était
    const updatedAdmins = room.admins.filter((a) => a !== String(participantId));

    // S'assurer qu'il reste au moins un admin après la suppression
    if (updatedAdmins.length === 0) {
      throw new ForbiddenException(
        'Impossible de retirer ce participant : la salle se retrouverait sans admin'
      );
    }

    const updatedParticipants = room.participants.filter((p) => p !== String(participantId));

    await this.prisma.chatRoom.update({
      where: { id: roomId },
      data: {
        participants: updatedParticipants,
        admins: updatedAdmins,
      },
    });

    return { message: 'Participant retiré avec succès' };
  }

  // ==================== MESSAGES ====================

  async sendMessage(userId: number, dto: SendMessageDto, files?: Express.Multer.File[]) {
    // Vérifier que l'utilisateur est participant de la salle
    await this.getRoomById(dto.roomId, userId);

    const attachmentUrls: string[] = [];

    // Upload des fichiers si présents
    if (files && files.length > 0) {
      // Validate file sizes (10MB limit)
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          throw new BadRequestException(
            `Le fichier "${file.originalname}" est trop volumineux. Taille maximale: 10 MB.`
          );
        }
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { companyId: true },
      });

      if (!user?.companyId) {
        throw new BadRequestException('User company not found');
      }

      for (const file of files) {
        const fileName = `${Date.now()}-${file.originalname}`;
        const filePath = `chat/${dto.roomId}`;

        const objectName = await this.minioService.uploadFromBuffer(
          user.companyId,
          filePath,
          fileName,
          file.buffer,
          file.mimetype
        );

        attachmentUrls.push(objectName);
      }
    }

    // Créer le message
    // Store file messages with proper handling of both text and file
    let messageContent: string;
    let fileObjectName: string | null = null;

    if (attachmentUrls.length > 0) {
      fileObjectName = attachmentUrls[0];
      // If there's user text along with the file, store them together in JSON format
      if (dto.content && dto.content.trim()) {
        messageContent = JSON.stringify({
          text: dto.content,
          file: fileObjectName,
        });
      } else {
        // No text, just store the file object name directly
        messageContent = fileObjectName;
      }
    } else {
      // No file, just text
      messageContent = dto.content || '';
    }

    const message = await this.prisma.chatMessage.create({
      data: {
        roomId: dto.roomId,
        threadId: dto.threadId,
        senderId: userId,
        content: messageContent,
        type: dto.type,
        mentions: dto.mentions ? dto.mentions.map(String) : [],
        documentId: dto.documentId,
        requestId: dto.requestId ?? null,
        taskId: dto.taskId ?? null,
        appointmentId: dto.appointmentId ?? null,
        callId: dto.callId ?? null,
        readBy: [String(userId)],
      },
      include: {
        sender: {
          select: { id: true, username: true, email: true, firstName: true, lastName: true },
        },
        request: { select: { id: true, subject: true, type: true, status: true, urgency: true } },
        task: { select: { id: true, title: true, status: true, priority: true } },
        appointment: {
          select: {
            id: true,
            title: true,
            date: true,
            hour: true,
            status: true,
            type: true,
          },
        },
        call: {
          select: {
            id: true,
            callType: true,
            status: true,
            duration: true,
            initiatorId: true,
          },
        },
      },
    });

    // Mettre à jour lastActivity de la salle
    await this.prisma.chatRoom.update({
      where: { id: dto.roomId },
      data: {
        lastActivity: new Date(),
        lastMessageId: message.id,
      },
    });

    // Generate presigned URL for the file
    let fileUrl: string | null = null;
    let displayContent = message.content;
    let fileName: string | null = null;

    if ((dto.type === 'file' || dto.type === 'image') && fileObjectName) {
      try {
        fileUrl = await this.minioService.getPresignedUrl(fileObjectName, 7 * 24 * 60 * 60);
        fileName = fileObjectName; // Store the file object name/path

        // If content is JSON (has both text and file), extract the text for display
        if (message.content.startsWith('{') && message.content.includes('"text"')) {
          try {
            const parsed = JSON.parse(message.content);
            displayContent = parsed.text || '';
          } catch {
            // If JSON parse fails, keep original content
          }
        } else {
          // If not JSON, content is the file path, so don't show it as text
          displayContent = '';
        }
      } catch {
        fileUrl = null;
      }
    }

    return {
      ...message,
      content: displayContent, // Return the text content without the JSON wrapper
      appointment: normalizeAppointment(message.appointment),
      attachments: attachmentUrls,
      fileUrl,
      fileName, // Add filename for frontend to use
    };
  }

  async getRoomMessagesForCallUpdate(roomId: number, callId: number) {
    // Simplified version for call updates - no permission check needed
    const messages = await this.prisma.chatMessage.findMany({
      where: {
        roomId,
        callId,
        type: 'call',
        deleted: false,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        call: true,
      },
    });

    return messages;
  }

  async getRoomMessages(roomId: number, userId: number, limit: number = 50, page: number = 1) {
    await this.getRoomById(roomId, userId);
    const skip = (page - 1) * limit;

    const rawMessages = await this.prisma.chatMessage.findMany({
      where: { roomId, deleted: false },
      include: {
        sender: {
          select: { id: true, username: true, email: true, firstName: true, lastName: true },
        },
        request: { select: { id: true, subject: true, type: true, status: true, urgency: true } },
        task: { select: { id: true, title: true, status: true, priority: true } },
        appointment: {
          select: {
            id: true,
            title: true,
            date: true,
            hour: true,
            status: true,
            type: true,
          },
        },
        call: {
          select: {
            id: true,
            callType: true,
            status: true,
            duration: true,
            initiatorId: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip,
    });

    const total = await this.prisma.chatMessage.count({ where: { roomId, deleted: false } });

    // Generate presigned URLs for file messages
    const messages = await Promise.all(
      rawMessages.map(async (msg) => {
        const appointment = normalizeAppointment(msg.appointment);

        if ((msg.type === 'file' || msg.type === 'image') && msg.content) {
          let fileObjectName = msg.content;
          let displayContent: string;
          let fileName: string;

          // Check if content is JSON format (has both text and file)
          if (msg.content.startsWith('{') && msg.content.includes('"file"')) {
            try {
              const parsed = JSON.parse(msg.content);
              fileObjectName = parsed.file;
              displayContent = parsed.text || '';
              fileName = fileObjectName;
            } catch {
              // If JSON parse fails, treat content as file object name
              fileName = msg.content;
              displayContent = msg.content;
            }
          } else {
            // If not JSON, content is the file path
            fileName = msg.content;
            displayContent = ''; // Don't show file path as text
          }

          try {
            const fileUrl = await this.minioService.getPresignedUrl(
              fileObjectName,
              7 * 24 * 60 * 60
            );
            return { ...msg, content: displayContent, appointment, fileUrl, fileName };
          } catch {
            return { ...msg, content: displayContent, appointment, fileUrl: null, fileName };
          }
        }

        return { ...msg, appointment, fileUrl: null, fileName: null };
      })
    );

    return {
      messages: messages.reverse(),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Mark all unread messages in a room as read for the given user.
   * Updates readBy[] on every message not yet read by this user.
   */
  async markRoomAsRead(roomId: number, userId: number) {
    await this.getRoomById(roomId, userId);

    // Bulk-update: add userId to readBy for all unread messages in this room
    await this.prisma.chatMessage.updateMany({
      where: {
        roomId,
        deleted: false,
        senderId: { not: userId },
        NOT: { readBy: { has: String(userId) } },
      },
      data: {
        readBy: { push: String(userId) },
      },
    });

    return { success: true };
  }

  async markAsRead(messageId: number, userId: number) {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException('Message introuvable');
    }

    // Vérifier que l'utilisateur appartient à la room du message
    if (message.roomId) {
      await this.getRoomById(message.roomId, userId); // lève ForbiddenException si non participant
    }

    // Ajouter l'utilisateur à readBy s'il n'y est pas déjà
    if (!message.readBy.includes(String(userId))) {
      await this.prisma.chatMessage.update({
        where: { id: messageId },
        data: {
          readBy: {
            push: String(userId),
          },
        },
      });
    }

    return { message: 'Message marqué comme lu' };
  }

  /**
   * Get recent messages (last N) across all user's rooms.
   * Returns individual messages with sender info, room context, and unread status.
   */
  async getRecentMessages(userId: number, limit: number = 3) {
    // Get all rooms the user is a participant in
    const userRooms = await this.prisma.chatRoom.findMany({
      where: {
        participants: { has: String(userId) },
        status: 'active',
      },
      select: { id: true, type: true, participants: true },
    });

    if (userRooms.length === 0) {
      return { messages: [], unreadCount: 0 };
    }

    const roomIds = userRooms.map((r) => r.id);

    // Get recent received messages (not sent by current user)
    // Fetch more than we need so we can filter to unique senders
    const allRecentMessages = await this.prisma.chatMessage.findMany({
      where: {
        roomId: { in: roomIds },
        deleted: false,
        senderId: { not: userId },
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        room: {
          select: {
            id: true,
            name: true,
            type: true,
            participants: true,
          },
        },
        request: {
          select: { id: true, subject: true },
        },
        task: {
          select: { id: true, title: true },
        },
        appointment: {
          select: { id: true, title: true, date: true, hour: true, status: true, type: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50, // Fetch more to ensure we get enough unique senders
    });

    // Get last message from each unique sender (limit to N different users)
    const seenSenders = new Set<number>();
    const rawMessages: typeof allRecentMessages = [];

    for (const msg of allRecentMessages) {
      if (!seenSenders.has(msg.senderId)) {
        rawMessages.push(msg);
        seenSenders.add(msg.senderId);

        if (rawMessages.length >= limit) {
          break;
        }
      }
    }

    // Get participant profiles to determine category
    const allParticipantIds = [
      ...new Set(
        rawMessages
          .map((msg) => msg.room?.participants ?? [])
          .flat()
          .map(Number)
          .filter((id) => id !== userId && !isNaN(id))
      ),
    ];

    const participantProfiles = allParticipantIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: allParticipantIds } },
          select: {
            id: true,
            role: { select: { code: true } },
          },
        })
      : [];

    const profileMap = new Map(participantProfiles.map((p) => [p.id, p]));

    // Determine room category for each message (for navigation)
    const messagesWithCategory = await Promise.all(
      rawMessages.map(async (msg) => {
        // Find other participant in the room
        const otherParticipantId = msg.room?.participants.map(Number).find((id) => id !== userId);

        const otherProfile = otherParticipantId ? profileMap.get(otherParticipantId) : null;

        const otherRoleCode = (otherProfile?.role?.code ?? '').toLowerCase();

        const category =
          otherRoleCode === 'client' || otherRoleCode.startsWith('client_')
            ? 'client'
            : 'collaborateur';

        // Check if message is unread by current user
        const isUnread = msg.senderId !== userId && !msg.readBy.includes(String(userId));

        // Generate presigned URL for file messages
        let fileUrl: string | null = null;
        let displayContent = msg.content;
        let fileName: string | null = null;

        if ((msg.type === 'file' || msg.type === 'image') && msg.content) {
          let fileObjectName = msg.content;

          // Check if content is JSON format (has both text and file)
          if (msg.content.startsWith('{') && msg.content.includes('"file"')) {
            try {
              const parsed = JSON.parse(msg.content);
              fileObjectName = parsed.file;
              displayContent = parsed.text || '';
              fileName = fileObjectName;
            } catch {
              // If JSON parse fails, treat content as file object name
              fileName = msg.content;
            }
          } else {
            // If not JSON, content is the file path
            fileName = msg.content;
            displayContent = ''; // Don't show file path as text
          }

          try {
            fileUrl = await this.minioService.getPresignedUrl(fileObjectName, 7 * 24 * 60 * 60);
          } catch {
            fileUrl = null;
          }
        }

        return {
          id: msg.id,
          roomId: msg.roomId,
          senderId: msg.senderId,
          content: displayContent,
          type: msg.type,
          createdAt: msg.createdAt,
          unread: isUnread,
          sender: msg.sender,
          room: {
            id: msg.room?.id,
            name: msg.room?.name,
            type: msg.room?.type,
            category,
          },
          fileUrl,
          fileName,
          request: msg.request,
          task: msg.task,
          appointment: msg.appointment ? normalizeAppointment(msg.appointment) : null,
        };
      })
    );

    // Count total unread messages across all rooms
    const unreadCount = await this.prisma.chatMessage.count({
      where: {
        roomId: { in: roomIds },
        deleted: false,
        senderId: { not: userId },
        NOT: { readBy: { has: String(userId) } },
      },
    });

    return {
      messages: messagesWithCategory,
      unreadCount,
    };
  }

  /**
   * Get total count of unread messages across all user's rooms.
   */
  async getUnreadMessagesCount(userId: number) {
    // Get all rooms the user is a participant in
    const userRooms = await this.prisma.chatRoom.findMany({
      where: {
        participants: { has: String(userId) },
        status: 'active',
      },
      select: { id: true },
    });

    if (userRooms.length === 0) {
      return { count: 0 };
    }

    const roomIds = userRooms.map((r) => r.id);

    const count = await this.prisma.chatMessage.count({
      where: {
        roomId: { in: roomIds },
        deleted: false,
        senderId: { not: userId },
        NOT: { readBy: { has: String(userId) } },
      },
    });

    return { count };
  }

  /**
   * Mark all unread messages across all user's rooms as read.
   */
  async markAllRoomsAsRead(userId: number) {
    // Get all rooms the user is a participant in
    const userRooms = await this.prisma.chatRoom.findMany({
      where: {
        participants: { has: String(userId) },
        status: 'active',
      },
      select: { id: true },
    });

    if (userRooms.length === 0) {
      return { success: true, updatedCount: 0 };
    }

    const roomIds = userRooms.map((r) => r.id);

    // Bulk update: add userId to readBy for all unread messages
    const result = await this.prisma.chatMessage.updateMany({
      where: {
        roomId: { in: roomIds },
        deleted: false,
        senderId: { not: userId },
        NOT: { readBy: { has: String(userId) } },
      },
      data: {
        readBy: { push: String(userId) },
      },
    });

    return { success: true, updatedCount: result.count };
  }

  async editMessage(messageId: number, userId: number, content: string) {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException('Message introuvable');
    }

    if (message.senderId !== userId) {
      throw new ForbiddenException('Vous ne pouvez modifier que vos propres messages');
    }

    const updatedMessage = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: {
        content,
        edited: true,
        editedAt: new Date(),
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    return updatedMessage;
  }

  async updateMessage(messageId: number, data: { content?: string; [key: string]: any }) {
    const updatedMessage = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data,
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
        call: true,
      },
    });

    return updatedMessage;
  }

  async deleteMessage(messageId: number, userId: number) {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException('Message introuvable');
    }

    if (message.senderId !== userId) {
      throw new ForbiddenException('Vous ne pouvez supprimer que vos propres messages');
    }

    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: {
        deleted: true,
        deletedAt: new Date(),
      },
    });

    return {
      message: 'Message supprimé avec succès',
      messageId,
      roomId: message.roomId,
    };
  }

  // ==================== SHARED DOCUMENTS ====================

  async getSharedDocuments(roomId: number, userId: number, page = 1, pageSize = 20) {
    await this.getRoomById(roomId, userId);
    const skip = (page - 1) * pageSize;

    const [messages, total] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { roomId, deleted: false, type: { in: ['file', 'image'] } },
        select: {
          id: true,
          roomId: true,
          senderId: true,
          content: true,
          type: true,
          createdAt: true,
          documentId: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize,
        skip,
      }),
      this.prisma.chatMessage.count({
        where: { roomId, deleted: false, type: { in: ['file', 'image'] } },
      }),
    ]);

    // Generate presigned URLs — strategy differs by type:
    // - Images: always generate URL; frontend handles broken URLs via onError fallback
    // - Non-images (PDF, doc, etc.): check existence first to avoid displaying raw storage
    //   error content (e.g. NoSuchKey XML) inside preview iframes/cards
    const data = await Promise.all(
      messages.map(async (msg) => {
        let fileUrl: string | null = null;
        // content is the raw MinIO object path UNLESS the file was sent
        // alongside a caption, in which case sendMessage() stores it as
        // JSON {text, file} (same format getRoomMessages() already parses).
        let fileObjectName = msg.content;
        if (msg.content && msg.content.startsWith('{') && msg.content.includes('"file"')) {
          try {
            const parsed = JSON.parse(msg.content);
            fileObjectName = parsed.file;
          } catch {
            // Malformed JSON — fall back to treating content as the raw path
          }
        }

        if (fileObjectName) {
          try {
            if (msg.type === 'image') {
              fileUrl = await this.minioService.getPresignedUrl(fileObjectName, 7 * 24 * 60 * 60);
            } else {
              const exists = await this.minioService.fileExists(fileObjectName);
              if (exists) {
                fileUrl = await this.minioService.getPresignedUrl(fileObjectName, 7 * 24 * 60 * 60);
              }
            }
          } catch {
            fileUrl = null;
          }
        }
        return { ...msg, content: fileObjectName ?? msg.content, fileUrl };
      })
    );

    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  // ==================== SEARCH ====================

  async searchMessages(userId: number, dto: SearchMessagesDto) {
    const where: any = {
      deleted: false,
    };

    // Filtrer par salle si spécifié
    if (dto.roomId) {
      // Vérifier que l'utilisateur est participant
      await this.getRoomById(dto.roomId, userId);
      where.roomId = dto.roomId;
    } else {
      // Sinon, chercher uniquement dans les salles où l'utilisateur est participant
      const userRooms = await this.getUserRooms(userId);
      where.roomId = {
        in: userRooms.map((r) => r.id),
      };
    }

    // Filtrer par texte
    if (dto.query) {
      where.content = {
        contains: dto.query,
        mode: 'insensitive',
      };
    }

    // Filtrer par expéditeur
    if (dto.senderId) {
      where.senderId = dto.senderId;
    }

    // Filtrer par date
    if (dto.startDate || dto.endDate) {
      where.createdAt = {};
      if (dto.startDate) {
        where.createdAt.gte = new Date(dto.startDate);
      }
      if (dto.endDate) {
        where.createdAt.lte = new Date(dto.endDate);
      }
    }

    const limit = dto.limit || 20;
    const page = dto.page || 1;
    const skip = (page - 1) * limit;

    const messages = await this.prisma.chatMessage.findMany({
      where,
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
        room: {
          select: {
            id: true,
            name: true,
            type: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
      skip,
    });

    const total = await this.prisma.chatMessage.count({ where });

    return {
      messages,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ==================== THREADS ====================

  async createThread(userId: number, title: string, contextType?: string, contextId?: number) {
    const thread = await this.prisma.chatThread.create({
      data: {
        title,
        contextType,
        contextId,
        createdById: userId,
        participants: [String(userId)],
      },
      include: {
        createdBy: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    return thread;
  }

  async getThreadMessages(threadId: number, userId: number) {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
    });

    if (!thread) {
      throw new NotFoundException('Thread introuvable');
    }

    // Vérifier que l'utilisateur est participant
    if (!thread.participants.includes(String(userId))) {
      throw new ForbiddenException("Vous n'êtes pas participant de ce thread");
    }

    const messages = await this.prisma.chatMessage.findMany({
      where: {
        threadId,
        deleted: false,
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return messages;
  }

  async getUserById(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        photo: true,
      },
    });

    return user;
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import CircularProgress from "@mui/material/CircularProgress";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { Dayjs } from "dayjs";
import { useSelector } from "react-redux";
import { useAppDispatch } from "src/hooks/use-redux";
import { PageHeader } from "src/layouts/components/page-header";

import ConversationsList from "./views/ConversationsList";
import ChatWindow from "./views/ChatWindow";
import SharedMediaView from "./views/SharedMediaView";
import CreateGroupModal from "./components/CreateGroupModal";
import GroupManagementModal from "./components/GroupManagementModal";

import { useChatSocket } from "./hooks/useChatSocket";
import type { SocketMessage } from "./hooks/useChatSocket";

import {
  useConversations,
  useRoomMessages,
  mapApiMessageToMessage,
  mapRoomToConversation,
} from "./hooks/useChatData";
import type {
  MessageRequest,
  MessageTask,
  MessageAppointment,
  Conversation,
  ConversationCategory,
  Message,
  GroupMember,
} from "./data/types";
import {
  useSendMessageMutation,
  useGetUserRoomsQuery,
  useLazyGetRoomMessagesQuery,
  useMarkRoomAsReadMutation,
  useFindOrCreateDirectRoomMutation,
  useCreateRoomMutation,
  useUpdateRoomMutation,
  useAddParticipantMutation,
  useRemoveParticipantMutation,
  chatApi,
  type GetRoomsParams,
} from "src/lib/services/chatApi";

import type { RootState } from "src/lib/store";
import type { Role } from "src/types/auth";

type MessagesViewProps = {
  onOpenMedia?: () => void;
};

const MOBILE_BOTTOM_NAV_HEIGHT = 72;
const MOBILE_HEADER_HEIGHT = 88;

// ── Role helpers ──────────────────────────────────────────────────────────────
// Normalise whatever shape role arrives in to a lowercase code string.
function getRoleCode(role: Role | string | null | undefined): string {
  if (!role) return "";
  return (typeof role === "string" ? role : (role.code ?? "")).toLowerCase();
}

// True if the role code belongs to the "comptable / accountant" group.
function isComptableRole(code: string): boolean {
  return (
    code === "comptable" ||
    code === "accountant" ||
    code.includes("comptable") ||
    code.includes("accountant")
  );
}

// True if the role code belongs to the "client" group.
function isClientRole(code: string): boolean {
  return code === "client" || code.startsWith("client_");
}

// True if the role code belongs to the "collaborateur / collaborator" group.
function isCollaborateurRole(code: string): boolean {
  return (
    code === "collaborateur" ||
    code === "collaborator" ||
    code.includes("collaborateur") ||
    code.includes("collaborator")
  );
}

/**
 * Map the selected UI tab to the category string sent to the backend.
 *
 * Tab "client"        → filter by CLIENT participants       (Comptable viewer)
 * Tab "comptable"     → filter by ACCOUNTANT participants   (Client / Collaborateur viewer)
 * Tab "collaborateur" → filter by COLLABORATOR participants (Comptable / Collaborateur viewer)
 */
function resolveApiCategory(
  tab: ConversationCategory,
  _myRoleCode: string,
): string {
  if (tab === "client") return "client";
  if (tab === "comptable") return "comptable";
  if (tab === "collaborateur") return "collaborateur";
  return tab;
}

export default function MessagesView({ onOpenMedia }: MessagesViewProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const isMedium = useMediaQuery(theme.breakpoints.between("md", "lg"));
  const dispatch = useAppDispatch();
  const [searchParams] = useSearchParams();

  const rawUserId = useSelector((state: RootState) => state.auth.user?.id);
  const currentUid = rawUserId ? Number(rawUserId) : 0;

  const rawUserRole = useSelector((state: RootState) => state.auth.user?.role);
  const myRoleCode = getRoleCode(
    rawUserRole as Role | string | null | undefined,
  );
  const iAmComptable = isComptableRole(myRoleCode);
  const iAmClient = isClientRole(myRoleCode);
  const iAmCollaborateur = isCollaborateurRole(myRoleCode);

  // Determine user role for filters
  const userRoleForFilters: "comptable" | "client" | "collaborateur" | "other" =
    iAmComptable
      ? "comptable"
      : iAmClient
        ? "client"
        : iAmCollaborateur
          ? "collaborateur"
          : "other";

  // ── All local state declared first so roomsParams can reference them ───────
  const [activeFilters, setActiveFilters] = useState<
    (ConversationCategory | "unread")[]
  >(() => {
    // Default filters per role - show all categories by default
    if (iAmComptable) return ["client", "collaborateur", "group"];
    if (iAmClient) return ["comptable", "group"];
    if (iAmCollaborateur) return ["comptable", "collaborateur", "group"];
    return ["collaborateur", "group"];
  });

  const ROOMS_PAGE_SIZE = 10;
  const MESSAGES_PAGE_SIZE = 20;
  const [conversationsPage, setConversationsPage] = useState<number>(1);
  const [hasMoreConversations, setHasMoreConversations] =
    useState<boolean>(true);

  const [selectedConversation, setSelectedConversation] = useState<number>(
    () => {
      const rid = Number(searchParams.get("roomId"));
      return Number.isFinite(rid) && rid > 0 ? rid : 0;
    },
  );
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState<string>("");
  const searchDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const [selectedDateFilter, setSelectedDateFilter] = useState<Dayjs | null>(
    null,
  );
  const [desktopView, setDesktopView] = useState<"chat" | "media">("chat");
  const [mobileView, setMobileView] = useState<"list" | "chat" | "media">(
    "list",
  );

  // Ref to always have current selectedConversation in socket callbacks.
  const selectedConversationRef = useRef(selectedConversation);
  selectedConversationRef.current = selectedConversation;

  // Search debouncing: update debouncedSearchTerm after 500ms of no typing
  useEffect(() => {
    if (searchDebounceTimer.current) {
      clearTimeout(searchDebounceTimer.current);
    }

    searchDebounceTimer.current = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
      setConversationsPage(1); // Reset to first page on search
    }, 500);

    return () => {
      if (searchDebounceTimer.current) {
        clearTimeout(searchDebounceTimer.current);
      }
    };
  }, [searchTerm]);

  // Reset page when filters change
  useEffect(() => {
    setConversationsPage(1);
  }, [activeFilters, selectedDateFilter]);

  // ── API query params (drives the rooms list query) ─────────────────────────
  const roomsParams = useMemo<GetRoomsParams>(() => {
    const categoryFilters = activeFilters.filter(
      (f) => f !== "unread",
    ) as ConversationCategory[];
    const hasUnreadFilter = activeFilters.includes("unread");

    const p: GetRoomsParams = {
      page: conversationsPage,
      pageSize: ROOMS_PAGE_SIZE,
      categories: categoryFilters.length > 0 ? categoryFilters : undefined,
      search: debouncedSearchTerm || undefined,
      date: selectedDateFilter
        ? selectedDateFilter.format("YYYY-MM-DD")
        : undefined,
      unreadOnly: hasUnreadFilter || undefined,
    };

    return p;
  }, [
    activeFilters,
    conversationsPage,
    debouncedSearchTerm,
    selectedDateFilter,
  ]);

  // Keep a ref so socket callbacks can always read the current params
  const roomsParamsRef = useRef(roomsParams);
  roomsParamsRef.current = roomsParams;

  // ── API data ──────────────────────────────────────────────────────────────
  const { conversations: apiConversations, isLoading: roomsLoading } =
    useConversations(roomsParams);
  const { data: roomsResponse } = useGetUserRoomsQuery(roomsParams);
  const rawRooms = useMemo(
    () => roomsResponse?.data ?? [],
    [roomsResponse?.data],
  );

  // Update hasMore when response changes
  useEffect(() => {
    if (roomsResponse) {
      setHasMoreConversations(roomsResponse.page < roomsResponse.totalPages);
    }
  }, [roomsResponse]);

  // Fetch all rooms (no filters) for badge counts and group modal contacts
  const allRoomsParams = useMemo<GetRoomsParams>(
    () => ({
      page: 1,
      pageSize: 500,
      categories: iAmComptable
        ? ["client", "collaborateur", "group"]
        : iAmClient
          ? ["comptable", "group"]
          : iAmCollaborateur
            ? ["comptable", "collaborateur", "group"]
            : ["collaborateur", "group"],
    }),
    [iAmComptable, iAmClient, iAmCollaborateur],
  );

  const allRoomsParamsRef = useRef(allRoomsParams);
  allRoomsParamsRef.current = allRoomsParams;

  const { data: allRoomsResponse } = useGetUserRoomsQuery(allRoomsParams, {
    refetchOnMountOrArgChange: true,
  });

  // Use allRoomsResponse for both badge counts and group modal contacts
  const allContactsResponse = useMemo(() => {
    return { data: allRoomsResponse?.data ?? [] };
  }, [allRoomsResponse]);

  // Derive real contacts for the group creation modal, filtered by current user's role
  const { groupModalClients, groupModalCollaborators } = useMemo(() => {
    const rooms = allContactsResponse?.data ?? [];
    const seen = new Set<number>();
    const clients: GroupMember[] = [];
    const collabs: GroupMember[] = [];

    for (const room of rooms) {
      for (const p of room.participantProfiles ?? []) {
        const pid = Number(p.id);
        if (pid === currentUid || seen.has(pid)) continue;
        seen.add(pid);

        const fullName =
          [p.firstName, p.lastName].filter(Boolean).join(" ") ||
          p.username ||
          p.email ||
          "?";
        const avatar = fullName
          .split(" ")
          .map((w) => w[0])
          .filter(Boolean)
          .join("")
          .slice(0, 2)
          .toUpperCase();
        const roleCode = (p.role?.code ?? "").toLowerCase();

        if (roleCode === "client" || roleCode.startsWith("client_")) {
          clients.push({ id: pid, name: fullName, role: "client", avatar });
        } else if (
          roleCode === "accountant" ||
          roleCode === "comptable" ||
          roleCode.includes("accountant") ||
          roleCode.includes("comptable")
        ) {
          collabs.push({ id: pid, name: fullName, role: "comptable", avatar });
        } else {
          collabs.push({
            id: pid,
            name: fullName,
            role: "collaborateur",
            avatar,
          });
        }
      }
    }

    // ACCOUNTANT: can add both clients and collaborateurs
    // CLIENT / COLLABORATOR: can only add collaborateurs (their accountant/colleagues)
    return {
      groupModalClients: iAmComptable ? clients : [],
      groupModalCollaborators: collabs,
    };
  }, [allContactsResponse, currentUid, iAmComptable]);

  // Calculate badge counts from all rooms
  const badgeCounts = useMemo(() => {
    const allConversations = (allRoomsResponse?.data ?? []).map((room) =>
      mapRoomToConversation(room, currentUid),
    );

    const counts: Record<string, number> = {
      client: 0,
      comptable: 0,
      collaborateur: 0,
      group: 0,
      unread: 0,
    };

    allConversations.forEach((conv) => {
      if (conv.unreadCount > 0) {
        counts.unread += conv.unreadCount;
      }

      if (conv.category && counts[conv.category] !== undefined) {
        counts[conv.category] += conv.unreadCount;
      }
    });

    return counts;
  }, [allRoomsResponse, currentUid]);

  // Load more conversations (infinite scroll)
  const handleLoadMoreConversations = useCallback(() => {
    if (!hasMoreConversations || roomsLoading) return;
    setConversationsPage((prev) => prev + 1);
  }, [hasMoreConversations, roomsLoading]);

  const [triggerSendMessage] = useSendMessageMutation();
  const [triggerGetOlderMessages] = useLazyGetRoomMessagesQuery();
  const [triggerMarkRoomAsRead] = useMarkRoomAsReadMutation();
  const [triggerFindOrCreateDirectRoom] = useFindOrCreateDirectRoomMutation();
  const [createRoom] = useCreateRoomMutation();
  const [updateGroupRoom] = useUpdateRoomMutation();
  const [addParticipant] = useAddParticipantMutation();
  const [removeParticipant] = useRemoveParticipantMutation();

  // Older messages accumulation per room (scroll-based infinite loading)
  const [olderMessagesByRoom, setOlderMessagesByRoom] = useState<
    Record<number, Message[]>
  >({});
  const [nextOlderPageByRoom, setNextOlderPageByRoom] = useState<
    Record<number, number>
  >({});
  const [isLoadingOlderByRoom, setIsLoadingOlderByRoom] = useState<
    Record<number, boolean>
  >({});

  // Typing indicator state: for each roomId, the set of userIds currently
  // typing. Keyed by user (not just room) so that in group conversations one
  // participant stopping doesn't erase the indicator while another is still
  // typing.
  const [typingUsersByRoom, setTypingUsersByRoom] = useState<
    Map<number, Set<number>>
  >(new Map());

  // Safety-net timeouts per (room, user) pair: auto-clears a stuck "typing"
  // indicator if no typing:stop ever arrives for that user (e.g. the peer's
  // tab crashes or network drops mid-keystroke, before their own client-side
  // stop timer or our disconnect cleanup on the server has a chance to fire).
  const typingSafetyTimeoutsRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());

  useEffect(() => {
    const timeouts = typingSafetyTimeoutsRef.current;
    return () => {
      timeouts.forEach((t) => clearTimeout(t));
      timeouts.clear();
    };
  }, []);

  // Buffer realtime messages that arrive before the active conversation is ready.
  // This prevents "works for sender, not for recipient until refresh" cases caused by timing.
  const pendingRealtimeByRoomRef = useRef<Map<number, SocketMessage[]>>(
    new Map(),
  );

  // ── Socket ────────────────────────────────────────────────────────────────
  const { joinRoom, leaveRoom, emitTyping } = useChatSocket({
    activeRoomId: selectedConversation,
    onReconnect: () => {
      // After a socket reconnect, messages may have been emitted while the
      // socket was down. Invalidate the current room's cache so RTK Query
      // refetches and the UI is up to date.
      const roomId = selectedConversationRef.current;
      if (roomId) {
        dispatch(
          chatApi.util.invalidateTags([{ type: "ChatMessages", id: roomId }]),
        );
      }
    },
    onMessageNew: (msg: SocketMessage) => {
      // Call-status system messages (started/rejected/missed/ended) are
      // never added optimistically by any client — unlike a user-typed
      // message, whose sender already injects it into the cache from the
      // send mutation's own response. Skipping "own" messages here would
      // otherwise hide these cards from the call's initiator, since the
      // backend records the initiator as the senderId regardless of who
      // actually rejected/ended the call.
      const isMine = msg.senderId === currentUid && msg.type !== "call";
      const activeRoomId = selectedConversationRef.current;

      if (isMine) {
        return;
      }

      // 1. Inject into getRoomMessages cache for that room
      // Only update messages for the currently visible conversation.
      if (activeRoomId && msg.roomId === activeRoomId) {
        dispatch(
          chatApi.util.updateQueryData(
            "getRoomMessages",
            { roomId: msg.roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
            (draft) => {
              if (draft.messages.some((m) => m.id === msg.id)) {
                return;
              }
              draft.messages.push({
                id: msg.id,
                roomId: msg.roomId,
                senderId: msg.senderId,
                content: msg.content,
                type: msg.type,
                createdAt: msg.createdAt,
                deleted: false,
                edited: false,
                fileUrl: msg.fileUrl ?? null,
                attachments: msg.attachments,
                sender: msg.sender,
                requestId: msg.requestId ?? undefined,
                taskId: msg.taskId ?? undefined,
                appointmentId: msg.appointmentId ?? undefined,
                callId: msg.callId ?? undefined,
                request: msg.request ?? undefined,
                task: msg.task ?? undefined,
                appointment: msg.appointment ?? undefined,
                call: msg.call ?? undefined,
              });
              draft.total += 1;
            },
          ),
        );
      } else {
        const existing = pendingRealtimeByRoomRef.current.get(msg.roomId) ?? [];
        pendingRealtimeByRoomRef.current.set(msg.roomId, [...existing, msg]);
      }

      // 2. Update rooms list preview + reorder + unread count
      const isActiveRoom = msg.roomId === selectedConversationRef.current;

      // Helper that patches a getUserRooms cache entry
      const patchRoomsCache = (params: typeof roomsParamsRef.current) => {
        dispatch(
          chatApi.util.updateQueryData("getUserRooms", params, (draft) => {
            const room = draft.data.find((r) => r.id === msg.roomId);
            if (!room) return;

            room.lastMessage = {
              id: msg.id,
              roomId: msg.roomId,
              content: msg.content,
              type: msg.type,
              senderId: msg.senderId,
              createdAt: msg.createdAt,
            };
            room.lastActivity = msg.createdAt;

            // Increment unread count only for rooms that are NOT currently open
            if (!isActiveRoom) {
              room.unreadCount = (room.unreadCount ?? 0) + 1;
            }

            // Bubble room to top
            const idx = draft.data.findIndex((r) => r.id === msg.roomId);
            if (idx > 0) {
              const [moved] = draft.data.splice(idx, 1);
              draft.data.unshift(moved);
            }
          }),
        );
      };

      // Patch the active tab's cache (used for the conversation list)
      patchRoomsCache(roomsParamsRef.current);

      // Also patch all rooms cache for badge counts
      patchRoomsCache(allRoomsParamsRef.current);

      // Prevent stale optimistic preview overrides from overriding the
      // computed preview for the current authenticated user.
      setConversationOverrides((prev) => {
        if (!prev[msg.roomId]) return prev;
        const next = { ...prev };
        delete next[msg.roomId];
        return next;
      });
    },

    onMessageUpdated: (msg: SocketMessage) => {
      const activeRoomId = selectedConversationRef.current;
      if (activeRoomId && msg.roomId === activeRoomId) {
        dispatch(
          chatApi.util.updateQueryData(
            "getRoomMessages",
            { roomId: msg.roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
            (draft) => {
              const existing = draft.messages.find((m) => m.id === msg.id);
              if (existing) {
                existing.content = msg.content;
                existing.edited = true;
              }
            },
          ),
        );
      }
    },

    onMessageDeleted: ({ messageId, roomId }) => {
      if (!roomId) return;

      const activeRoomId = selectedConversationRef.current;
      if (!activeRoomId || roomId !== activeRoomId) return;

      dispatch(
        chatApi.util.updateQueryData(
          "getRoomMessages",
          { roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
          (draft) => {
            const idx = draft.messages.findIndex((m) => m.id === messageId);
            if (idx !== -1) draft.messages.splice(idx, 1);
          },
        ),
      );
    },

    onTyping: ({ roomId, userId, typing }) => {
      if (userId === currentUid) return;

      // Keyed by room AND user: in a group conversation, user A stopping
      // must not clear the safety timer (or the indicator) for user B who
      // may still be typing in the same room.
      const key = `${roomId}:${userId}`;

      const existingTimeout = typingSafetyTimeoutsRef.current.get(key);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        typingSafetyTimeoutsRef.current.delete(key);
      }

      setTypingUsersByRoom((prev) => {
        const roomTypers = new Set(prev.get(roomId));
        if (typing) roomTypers.add(userId);
        else roomTypers.delete(userId);

        const next = new Map(prev);
        if (roomTypers.size > 0) next.set(roomId, roomTypers);
        else next.delete(roomId);
        return next;
      });

      if (typing) {
        const timeoutId = setTimeout(() => {
          setTypingUsersByRoom((prev) => {
            const roomTypers = prev.get(roomId);
            if (!roomTypers?.has(userId)) return prev;

            const updated = new Set(roomTypers);
            updated.delete(userId);

            const next = new Map(prev);
            if (updated.size > 0) next.set(roomId, updated);
            else next.delete(roomId);
            return next;
          });
          typingSafetyTimeoutsRef.current.delete(key);
        }, 5000);
        typingSafetyTimeoutsRef.current.set(key, timeoutId);
      }
    },

    onCallMessageUpdated: ({
      messageId,
      roomId,
      callId,
      status,
      duration,
      content,
    }) => {
      // Update the message in the cache - for ALL pages, not just active room
      dispatch(
        chatApi.util.updateQueryData(
          "getRoomMessages",
          { roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
          (draft) => {
            const existing = draft.messages.find((m) => m.id === messageId);
            if (existing && existing.call) {
              existing.content = content;
              existing.call.status = status;
              existing.call.duration = duration;
            }
          },
        ),
      );

      // Also update the preview in rooms list
      const patchRoomsCache = (params: typeof roomsParamsRef.current) => {
        dispatch(
          chatApi.util.updateQueryData("getUserRooms", params, (draft) => {
            const room = draft.data.find((r) => r.id === roomId);
            if (room && room.lastMessage) {
              room.lastMessage.content = content;
              room.lastActivity = new Date().toISOString();
            }
          }),
        );
      };

      patchRoomsCache(roomsParamsRef.current);
      patchRoomsCache(allRoomsParamsRef.current);
    },
  });

  // Join/leave room via socket when selected conversation changes
  useEffect(() => {
    if (!selectedConversation) return undefined;

    joinRoom(selectedConversation);
    return () => {
      leaveRoom(selectedConversation);
    };
  }, [selectedConversation, joinRoom, leaveRoom]);

  // Flush any buffered realtime messages when the room becomes active.
  useEffect(() => {
    const roomId = selectedConversation;
    if (!roomId) return;

    const pending = pendingRealtimeByRoomRef.current.get(roomId);
    if (!pending || pending.length === 0) return;

    pendingRealtimeByRoomRef.current.delete(roomId);

    pending.forEach((msg) => {
      dispatch(
        chatApi.util.updateQueryData(
          "getRoomMessages",
          { roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
          (draft) => {
            if (draft.messages.some((m) => m.id === msg.id)) return;
            draft.messages.push({
              id: msg.id,
              roomId: msg.roomId,
              senderId: msg.senderId,
              content: msg.content,
              type: msg.type,
              createdAt: msg.createdAt,
              deleted: false,
              edited: false,
              fileUrl: msg.fileUrl ?? null,
              attachments: msg.attachments,
              sender: msg.sender,
            });
            draft.total += 1;
          },
        ),
      );
    });
  }, [selectedConversation, dispatch]);

  // Note: Socket connection is managed globally now
  // Don't disconnect when leaving messages page since calls work everywhere

  // Local overrides for optimistic UI (preview text, unread counts)
  const [conversationOverrides, setConversationOverrides] = useState<
    Record<number, Partial<Conversation>>
  >({});

  // Upload progress tracking
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);

  // Group chat state
  const [openCreateGroupModal, setOpenCreateGroupModal] = useState(false);
  const [openManageGroupModal, setOpenManageGroupModal] = useState(false);
  const [selectedGroupForManagement, setSelectedGroupForManagement] = useState<
    number | null
  >(null);

  // Handlers for group operations
  const handleCreateGroup = async (groupName: string, memberIds: number[]) => {
    try {
      const newRoom = await createRoom({
        type: "group",
        name: groupName,
        participants: memberIds,
      }).unwrap();

      // createRoom mutation already invalidates ChatRooms LIST — the list will
      // refetch automatically and include the new group.
      setSelectedConversation(newRoom.id);
      // Explicitly join the new room's socket channel so real-time works immediately
      joinRoom(newRoom.id);
      setOpenCreateGroupModal(false);
    } catch {
      /* ignored */
    }
  };

  const handleUpdateGroup = async (
    groupName: string,
    members: GroupMember[],
  ) => {
    if (!selectedGroupForManagement) return;

    // Capture before any async gap — the modal closes immediately after calling
    // onUpdate(), so selectedGroupForManagement will be null by the time awaits resolve.
    const roomId = selectedGroupForManagement;

    // Compute diff between current and new member lists.
    const currentGroup = allConversations.find((c) => c.id === roomId);
    const currentMemberIds = new Set(
      (currentGroup?.members ?? []).map((m) => m.id),
    );
    const newMemberIds = new Set(members.map((m) => m.id));

    const added = members.filter((m) => !currentMemberIds.has(m.id));
    const removed = (currentGroup?.members ?? []).filter(
      (m) => !newMemberIds.has(m.id),
    );

    try {
      await Promise.all([
        // Rename if the name changed (PATCH /chat/rooms/:id)
        ...(currentGroup?.name !== groupName
          ? [updateGroupRoom({ roomId, name: groupName }).unwrap()]
          : []),
        // Add new participants
        ...added.map((m) =>
          addParticipant({ roomId, participantId: m.id }).unwrap(),
        ),
        // Remove departed participants
        ...removed.map((m) =>
          removeParticipant({ roomId, participantId: m.id }).unwrap(),
        ),
      ]);
      // Invalidate the rooms LIST so getUserRooms refetches and apiConversations
      // reflects the updated name and participant count.
      dispatch(
        chatApi.util.invalidateTags([{ type: "ChatRooms", id: "LIST" }]),
      );
    } catch {
      /* ignored */
    }
  };

  const handleManageGroup = (groupId: number) => {
    setSelectedGroupForManagement(groupId);
    setOpenManageGroupModal(true);
  };

  // True if the current user is an admin of the group being managed
  const selectedGroupIsAdmin = useMemo(() => {
    if (!selectedGroupForManagement) return false;
    // Search in rawRooms (current tab) then in allContactsResponse (all rooms)
    const allRooms = [...rawRooms, ...(allContactsResponse?.data ?? [])];
    const room = allRooms.find((r) => r.id === selectedGroupForManagement);
    if (!room) return false;
    return room.admins?.includes(String(currentUid)) ?? false;
  }, [selectedGroupForManagement, rawRooms, allContactsResponse, currentUid]);

  // Since backend now handles all filtering, just apply conversation overrides
  const allConversations: Conversation[] = useMemo(() => {
    return apiConversations.map((c) => ({
      ...c,
      ...(conversationOverrides[c.id] ?? {}),
    }));
  }, [apiConversations, conversationOverrides]);

  const allConversationsForBadges: Conversation[] = useMemo(() => {
    const allRooms = allContactsResponse?.data ?? [];
    const result = allRooms.map((room) => {
      const mapped = mapRoomToConversation(room, currentUid);
      return { ...mapped, ...(conversationOverrides[mapped.id] ?? {}) };
    });
    return result;
  }, [allContactsResponse, currentUid, conversationOverrides]);

  // Auto-select first conversation when rooms load (only if no room was pre-selected via URL)
  useEffect(() => {
    if (allConversations.length > 0 && selectedConversation === 0) {
      setSelectedConversation(allConversations[0].id);
    }
  }, [allConversations, selectedConversation]);

  // When a tab switch is triggered by the popover, the target room may not yet
  // be in allConversations (it loads after the tab change). This ref holds the
  // roomId we want to select once it becomes available.
  const pendingRoomIdRef = useRef<number>(0);

  // Once allConversations updates after a tab switch, resolve the pending room.
  useEffect(() => {
    const pending = pendingRoomIdRef.current;
    if (!pending) return;
    const found = allConversations.find((c) => Number(c.id) === pending);
    if (found) {
      pendingRoomIdRef.current = 0;
      setSelectedConversation(found.id);
    }
  }, [allConversations]);

  // On mobile, navigate straight to chat if a roomId was passed via URL param
  useEffect(() => {
    const rid = Number(searchParams.get("roomId"));
    if (rid > 0 && isMobile) {
      setMobileView("chat");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount

  // Sync room selection whenever URL params change (handles navigation from the
  // messages popover while this page is already mounted — useState initializers
  // only run on first mount so they miss subsequent URL changes).
  useEffect(() => {
    const rid = Number(searchParams.get("roomId"));
    if (rid <= 0) return;

    // Mark room as read
    setConversationOverrides((prev) => ({
      ...prev,
      [rid]: { ...(prev[rid] ?? {}), unreadCount: 0 },
    }));
    triggerMarkRoomAsRead(rid);

    // Reset unreadCount in RTK Query caches so badge counts update immediately
    const resetUnreadUrl = (params: typeof roomsParamsRef.current) => {
      dispatch(
        chatApi.util.updateQueryData("getUserRooms", params, (draft) => {
          const room = draft.data.find((r) => r.id === rid);
          if (room) room.unreadCount = 0;
        }),
      );
    };
    resetUnreadUrl(roomsParamsRef.current);
    resetUnreadUrl(allRoomsParamsRef.current);

    // Check if the target room is already visible in allConversations.
    // If not (tab just changed, list not yet loaded), store as pending.
    const alreadyVisible = allConversations.find((c) => Number(c.id) === rid);
    if (alreadyVisible) {
      pendingRoomIdRef.current = 0;
      setSelectedConversation(rid);
    } else {
      pendingRoomIdRef.current = rid;
      setSelectedConversation(rid); // Start loading messages immediately
    }

    if (isMobile) setMobileView("chat");
    else setDesktopView("chat");
  }, [searchParams, isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset older messages accumulation when switching conversations
  useEffect(() => {
    setOlderMessagesByRoom((prev) => ({ ...prev, [selectedConversation]: [] }));
    setNextOlderPageByRoom((prev) => ({ ...prev, [selectedConversation]: 2 }));
    setIsLoadingOlderByRoom((prev) => ({
      ...prev,
      [selectedConversation]: false,
    }));
  }, [selectedConversation]);

  // ── Messages for selected room ────────────────────────────────────────────
  const {
    messages: apiMessages,
    totalMessages,
    isFetching: messagesFetching,
  } = useRoomMessages(selectedConversation, 1, MESSAGES_PAGE_SIZE);

  // Optimistic local messages for messages sent by the current user
  const [localMessages, setLocalMessages] = useState<Record<number, Message[]>>(
    {},
  );

  const currentMessages: Message[] = useMemo(() => {
    // CRITICAL: always filter by selectedConversation to prevent cross-room contamination.
    // RTK Query may serve stale cache from a previously selected room while fetching
    // the new room's messages. We guard against this by checking each message's roomId.
    // apiMessages come from mapApiMessageToMessage which doesn't carry roomId, so we
    // use the raw data from the query to cross-check.
    const page1 = messagesFetching ? [] : apiMessages;
    const older = olderMessagesByRoom[selectedConversation] ?? [];
    const local = localMessages[selectedConversation] ?? [];

    const page1Ids = new Set(page1.map((m) => m.id));
    const olderFiltered = older.filter((m) => !page1Ids.has(m.id));
    const localFiltered = local.filter((lm) => {
      if (page1Ids.has(lm.id)) return false;

      if (lm.type === "text" && lm.text) {
        return !page1.some(
          (am) => am.mine && am.type === "text" && am.text === lm.text,
        );
      }

      if (lm.type === "file" && lm.file) {
        return !page1.some(
          (am) =>
            am.mine &&
            am.type === "file" &&
            am.file?.name === lm.file?.name &&
            Math.abs(
              new Date(am.date).getTime() - new Date(lm.date).getTime(),
            ) < 5000,
        );
      }

      if (lm.type === "request" && lm.request) {
        return !page1.some(
          (am) =>
            am.mine &&
            am.type === "request" &&
            am.request?.id === lm.request?.id,
        );
      }

      if (lm.type === "task" && lm.task) {
        return !page1.some(
          (am) => am.mine && am.type === "task" && am.task?.id === lm.task?.id,
        );
      }

      if (lm.type === "appointment" && lm.appointment) {
        return !page1.some(
          (am) =>
            am.mine &&
            am.type === "appointment" &&
            am.appointment?.id === lm.appointment?.id,
        );
      }

      return true;
    });

    return [...olderFiltered, ...page1, ...localFiltered];
  }, [
    apiMessages,
    messagesFetching,
    olderMessagesByRoom,
    localMessages,
    selectedConversation,
  ]);

  // Clear optimistic local messages once their content has been confirmed by the API.
  // Do NOT clear just because any apiMessages update arrived (another user's message
  // would trigger the old logic and prematurely erase the user's unconfirmed message).
  useEffect(() => {
    setLocalMessages((prev) => {
      if (!prev[selectedConversation]?.length) return prev;

      const confirmed = prev[selectedConversation].filter((lm) => {
        if (lm.type === "text" && lm.text) {
          return apiMessages.some(
            (am) => am.mine && am.type === "text" && am.text === lm.text,
          );
        }

        if (lm.type === "file" && lm.file) {
          return apiMessages.some(
            (am) =>
              am.mine &&
              am.type === "file" &&
              am.file?.name === lm.file?.name &&
              Math.abs(
                new Date(am.date).getTime() - new Date(lm.date).getTime(),
              ) < 5000,
          );
        }

        if (lm.type === "request" && lm.request) {
          return apiMessages.some(
            (am) =>
              am.mine &&
              am.type === "request" &&
              am.request?.id === lm.request?.id,
          );
        }

        if (lm.type === "task" && lm.task) {
          return apiMessages.some(
            (am) =>
              am.mine && am.type === "task" && am.task?.id === lm.task?.id,
          );
        }

        if (lm.type === "appointment" && lm.appointment) {
          return apiMessages.some(
            (am) =>
              am.mine &&
              am.type === "appointment" &&
              am.appointment?.id === lm.appointment?.id,
          );
        }

        return false;
      });

      if (confirmed.length === 0) return prev;

      const remaining = prev[selectedConversation].filter(
        (lm) => !confirmed.includes(lm),
      );
      const updated = { ...prev };
      if (remaining.length === 0) {
        delete updated[selectedConversation];
      } else {
        updated[selectedConversation] = remaining;
      }
      return updated;
    });
  }, [apiMessages, selectedConversation]);

  // ── Sync mobile view ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isMobile) setMobileView("list");
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) {
      document.body.removeAttribute("data-hide-bottom-nav");
    } else {
      const shouldHide = mobileView === "chat" || mobileView === "media";
      if (shouldHide) {
        document.body.setAttribute("data-hide-bottom-nav", "true");
      } else {
        document.body.removeAttribute("data-hide-bottom-nav");
      }
    }

    return () => {
      document.body.removeAttribute("data-hide-bottom-nav");
    };
  }, [isMobile, mobileView]);

  // ── Older messages (scroll-based loading) ────────────────────────────────
  const olderMessages = olderMessagesByRoom[selectedConversation] ?? [];
  const hasMoreOlderMessages =
    selectedConversation > 0 &&
    totalMessages > MESSAGES_PAGE_SIZE + olderMessages.length;
  const isLoadingOlder = isLoadingOlderByRoom[selectedConversation] ?? false;

  const handleLoadOlderMessages = useCallback(async () => {
    const roomId = selectedConversation;
    if (!roomId || isLoadingOlderByRoom[roomId]) return;
    if (!hasMoreOlderMessages) return;

    const nextPage = nextOlderPageByRoom[roomId] ?? 2;

    setIsLoadingOlderByRoom((prev) => ({ ...prev, [roomId]: true }));
    try {
      const result = await triggerGetOlderMessages(
        { roomId, page: nextPage, limit: MESSAGES_PAGE_SIZE },
        true,
      ).unwrap();
      const mapped = result.messages.map((m) =>
        mapApiMessageToMessage(m, currentUid),
      );
      setOlderMessagesByRoom((prev) => ({
        ...prev,
        // Prepend: new older page goes before existing older pages
        [roomId]: [...mapped, ...(prev[roomId] ?? [])],
      }));
      setNextOlderPageByRoom((prev) => ({ ...prev, [roomId]: nextPage + 1 }));
    } catch {
      // silent — user can scroll up again to retry
    } finally {
      setIsLoadingOlderByRoom((prev) => ({ ...prev, [roomId]: false }));
    }
  }, [
    selectedConversation,
    isLoadingOlderByRoom,
    hasMoreOlderMessages,
    nextOlderPageByRoom,
    currentUid,
    triggerGetOlderMessages,
  ]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleSelectConversation = async (id: number) => {
    // If it's a virtual room (negative ID), create the real room first
    if (id < 0) {
      const targetUserId = Math.abs(id);
      try {
        const result = await triggerFindOrCreateDirectRoom({
          targetUserId,
        }).unwrap();
        const realRoomId = result.id;

        // Now select the real room
        setSelectedConversation(realRoomId);

        if (isMobile) setMobileView("chat");
        else setDesktopView("chat");

        return;
      } catch {
        return;
      }
    }

    // Normal room selection
    setSelectedConversation(id);

    if (isMobile) setMobileView("chat");
    else setDesktopView("chat");

    setConversationOverrides((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? {}), unreadCount: 0 },
    }));

    // Reset unreadCount in RTK Query caches so badge counts update immediately
    const resetUnread = (params: typeof roomsParamsRef.current) => {
      dispatch(
        chatApi.util.updateQueryData("getUserRooms", params, (draft) => {
          const room = draft.data.find((r) => r.id === id);
          if (room) room.unreadCount = 0;
        }),
      );
    };
    resetUnread(roomsParamsRef.current);
    resetUnread(allRoomsParamsRef.current);

    // Persist read state to backend so it survives page reload
    triggerMarkRoomAsRead(id);
  };

  const handleSearchChange = (value: string) => setSearchTerm(value);
  const handleDateFilterChange = (value: Dayjs | null) =>
    setSelectedDateFilter(value);

  const handleFiltersChange = useCallback(
    (filters: (ConversationCategory | "unread")[]) => {
      setActiveFilters(filters);
      setSelectedConversation(0);
      if (isMobile) setMobileView("list");
      else setDesktopView("chat");
    },
    [isMobile],
  );

  const handleMarkCurrentRoomAsRead = useCallback(() => {
    if (selectedConversation > 0) {
      triggerMarkRoomAsRead(selectedConversation);
    }
  }, [selectedConversation, triggerMarkRoomAsRead]);

  const handleMessagesChange = async (updatedMessages: Message[]) => {
    const lastMessage = updatedMessages[updatedMessages.length - 1];
    if (!lastMessage || !lastMessage.mine) return;

    // Optimistic update
    setLocalMessages((prev) => ({
      ...prev,
      [selectedConversation]: [
        ...(prev[selectedConversation] ?? []),
        lastMessage,
      ],
    }));

    // Update conversation preview optimistically
    let previewText = "";
    if (lastMessage.type === "text") {
      previewText = lastMessage.text ?? "";
    } else if (lastMessage.type === "file") {
      const text = lastMessage.text?.trim();
      previewText = text
        ? `${text} 📎 ${lastMessage.file?.name ?? "Fichier"}`
        : `📎 ${lastMessage.file?.name ?? "Fichier"}`;
    } else if (lastMessage.type === "request") {
      const text = lastMessage.text?.trim();
      previewText = text
        ? `${text} 🔗 Demande`
        : `🔗 ${lastMessage.request?.title ?? "Demande"}`;
    } else if (lastMessage.type === "task") {
      const text = lastMessage.text?.trim();
      previewText = text
        ? `${text} ✓ Tâche`
        : `✓ ${lastMessage.task?.title ?? "Tâche"}`;
    } else if (lastMessage.type === "appointment") {
      const text = lastMessage.text?.trim();
      previewText = text
        ? `${text} 📅 Rendez-vous`
        : `📅 ${lastMessage.appointment?.title ?? "Rendez-vous"}`;
    }

    setConversationOverrides((prev) => ({
      ...prev,
      [selectedConversation]: {
        ...(prev[selectedConversation] ?? {}),
        preview: `Vous : ${previewText}`,
        time: lastMessage.time,
        fullDate: new Date().toISOString(),
      },
    }));

    // Send typing stop when sending a message
    emitTyping(selectedConversation, false);

    // Send to API (text messages only; file handling stays in ChatWindow)
    if (lastMessage.type === "text" && lastMessage.text) {
      try {
        const saved = await triggerSendMessage({
          roomId: selectedConversation,
          content: lastMessage.text,
          type: "text",
        }).unwrap();

        dispatch(
          chatApi.util.updateQueryData(
            "getRoomMessages",
            {
              roomId: selectedConversation,
              page: 1,
              limit: MESSAGES_PAGE_SIZE,
            },
            (draft) => {
              if (draft.messages.some((m) => m.id === saved.id)) {
                return;
              }
              draft.messages.push(saved);
              draft.total += 1;
            },
          ),
        );

        setLocalMessages((prev) => {
          const updated = { ...prev };
          delete updated[selectedConversation];
          return updated;
        });
      } catch {
        // Keep optimistic message visible even on error
      }
    }
  };

  // Custom upload with progress tracking
  const uploadFileWithProgress = async (
    roomId: number,
    file: File,
    messageContent: string,
    messageType: string,
    requestId?: number,
    taskId?: number,
    appointmentId?: number,
  ): Promise<any> => {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("roomId", String(roomId));
      formData.append("content", messageContent);
      formData.append("type", messageType);
      if (requestId) formData.append("requestId", String(requestId));
      if (taskId) formData.append("taskId", String(taskId));
      if (appointmentId)
        formData.append("appointmentId", String(appointmentId));
      formData.append("attachments", file);

      const xhr = new XMLHttpRequest();
      const token = localStorage.getItem("token");
      const apiUrl =
        import.meta.env.VITE_API_URL || "http://localhost:3000/api";

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const percentComplete = Math.round((e.loaded / e.total) * 100);
          setUploadProgress(percentComplete);
        }
      });

      xhr.addEventListener("load", () => {
        setIsUploading(false);
        setUploadProgress(0);

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            resolve(response);
          } catch (err) {
            reject(new Error("Failed to parse response"));
          }
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => {
        setIsUploading(false);
        setUploadProgress(0);
        reject(new Error("Network error during upload"));
      });

      xhr.addEventListener("abort", () => {
        setIsUploading(false);
        setUploadProgress(0);
        reject(new Error("Upload cancelled"));
      });

      xhr.open("POST", `${apiUrl}/chat/messages`);
      if (token) {
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      }

      setIsUploading(true);
      setUploadProgress(0);
      xhr.send(formData);
    });
  };

  const handleSendFile = async (
    messageHtml: string,
    file?: File,
    request?: MessageRequest,
    task?: MessageTask,
    appointment?: MessageAppointment,
  ) => {
    const roomId = selectedConversationRef.current;
    if (!roomId) return;

    // Extract plain text from HTML for the content field
    const div = document.createElement("div");
    div.innerHTML = messageHtml;
    const plainText = (div.textContent || "").replace(/\u00a0/g, " ").trim();
    // For a file/image attachment, content must only ever be text the user
    // deliberately typed as a caption - never the file's own name, which is
    // already conveyed via fileName/fileUrl metadata. Falling back to
    // file.name here used to make the backend treat it as a real caption
    // (see sendMessage's JSON {text, file} wrapping), which the UI then
    // rendered as a second, separate bubble showing the filename as text.
    const messageContent = file
      ? plainText
      : plainText || request?.title || task?.title || appointment?.title || "";

    // Send via API
    if (file) {
      const messageType = file.type?.startsWith("image/") ? "image" : "file";

      try {
        const saved = await uploadFileWithProgress(
          roomId,
          file,
          messageContent,
          messageType,
          request?.id,
          task?.id,
          appointment?.id,
        );

        dispatch(
          chatApi.util.updateQueryData(
            "getRoomMessages",
            { roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
            (draft) => {
              if (draft.messages.some((m) => m.id === saved.id)) {
                return;
              }
              draft.messages.push({
                id: saved.id,
                roomId: saved.roomId,
                senderId: saved.senderId,
                content: saved.content,
                type: saved.type,
                createdAt: saved.createdAt,
                deleted: false,
                edited: false,
                fileUrl: saved.fileUrl ?? null,
                fileName: saved.fileName ?? null,
                attachments: saved.attachments,
                sender: saved.sender,
                requestId: saved.requestId ?? undefined,
                taskId: saved.taskId ?? undefined,
                appointmentId: saved.appointmentId ?? undefined,
                callId: saved.callId ?? undefined,
                request: saved.request ?? undefined,
                task: saved.task ?? undefined,
                appointment: saved.appointment ?? undefined,
                call: saved.call ?? undefined,
              });
              draft.total += 1;
            },
          ),
        );

        setLocalMessages((prev) => {
          const updated = { ...prev };
          delete updated[roomId];
          return updated;
        });
      } catch {
        /* ignored */
      }
    } else if (request) {
      try {
        const saved = await triggerSendMessage({
          roomId,
          content: messageContent,
          type: "text",
          requestId: request.id,
        }).unwrap();

        dispatch(
          chatApi.util.updateQueryData(
            "getRoomMessages",
            { roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
            (draft) => {
              if (draft.messages.some((m) => m.id === saved.id)) {
                return;
              }
              draft.messages.push(saved);
              draft.total += 1;
            },
          ),
        );

        setLocalMessages((prev) => {
          const updated = { ...prev };
          delete updated[roomId];
          return updated;
        });
      } catch {
        /* ignored */
      }
    } else if (task) {
      try {
        const saved = await triggerSendMessage({
          roomId,
          content: messageContent,
          type: "text",
          taskId: task.id,
        }).unwrap();

        dispatch(
          chatApi.util.updateQueryData(
            "getRoomMessages",
            { roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
            (draft) => {
              if (draft.messages.some((m) => m.id === saved.id)) {
                return;
              }
              draft.messages.push(saved);
              draft.total += 1;
            },
          ),
        );

        setLocalMessages((prev) => {
          const updated = { ...prev };
          delete updated[roomId];
          return updated;
        });
      } catch {
        /* ignored */
      }
    } else if (appointment) {
      try {
        const saved = await triggerSendMessage({
          roomId,
          content: messageContent,
          type: "text",
          appointmentId: appointment.id,
        }).unwrap();

        dispatch(
          chatApi.util.updateQueryData(
            "getRoomMessages",
            { roomId, page: 1, limit: MESSAGES_PAGE_SIZE },
            (draft) => {
              if (draft.messages.some((m) => m.id === saved.id)) {
                return;
              }
              draft.messages.push(saved);
              draft.total += 1;
            },
          ),
        );

        setLocalMessages((prev) => {
          const updated = { ...prev };
          delete updated[roomId];
          return updated;
        });
      } catch {
        /* ignored */
      }
    }
  };

  // ── Derived state ─────────────────────────────────────────────────────────
  // Filtering (category, search, date) is handled server-side via roomsParams.
  // allConversations already contains only the relevant subset from the API.
  // Client-side filtering: search by name, optional date filter.
  // No backend search — the full list is loaded upfront (ROOMS_PAGE_SIZE = 500).
  // Backend now handles all filtering (search, categories, unread, date),
  // so just use apiConversations directly
  const filteredConversations = useMemo(() => {
    return apiConversations;
  }, [apiConversations]);

  useEffect(() => {
    if (filteredConversations.length === 0) return;
    // While rooms are being fetched (e.g. after a tab/category change triggered
    // by URL navigation), the new room hasn't arrived yet — don't override.
    if (roomsLoading) return;

    const selectedStillExists = filteredConversations.some(
      (c) => c.id === selectedConversation,
    );

    if (!selectedStillExists) {
      setSelectedConversation(filteredConversations[0].id);
      if (isMobile) setMobileView("list");
      else setDesktopView("chat");
    }
  }, [filteredConversations, selectedConversation, isMobile, roomsLoading]);

  const hasSelectedConversation = filteredConversations.some(
    (c) => c.id === selectedConversation,
  );

  const showEmptyState =
    filteredConversations.length === 0 || !hasSelectedConversation;

  const currentConversation = useMemo(
    () => allConversations.find((c) => c.id === selectedConversation),
    [allConversations, selectedConversation],
  );

  const currentRoom = useMemo(
    () => rawRooms.find((r) => r.id === selectedConversation),
    [rawRooms, selectedConversation],
  );

  const recipientInfo = useMemo(() => {
    if (!currentRoom) return { recipientType: null, recipientId: null };

    const profiles = currentRoom.participantProfiles ?? [];
    const otherParticipant = profiles.find((p) => Number(p.id) !== currentUid);

    const currentUserIsClient = isClientRole(myRoleCode);
    const currentUserIsCollaborator = isCollaborateurRole(myRoleCode);

    let recipientType: "client" | "collaborator";
    let recipientId: number | null;

    if (currentUserIsClient) {
      recipientType = "client";
      recipientId = currentUid;
    } else if (currentUserIsCollaborator) {
      const otherRoleCode = (otherParticipant?.role?.code ?? "").toLowerCase();
      if (otherRoleCode === "client" || otherRoleCode.startsWith("client_")) {
        recipientType = "client";
        recipientId = otherParticipant?.id ?? null;
      } else {
        recipientType = "collaborator";
        recipientId = currentUid;
      }
    } else {
      const otherRoleCode = (otherParticipant?.role?.code ?? "").toLowerCase();
      recipientType =
        otherRoleCode === "client" || otherRoleCode.startsWith("client_")
          ? "client"
          : "collaborator";
      recipientId = otherParticipant?.id ?? null;
    }

    return {
      recipientType,
      recipientId,
    };
  }, [currentRoom, currentUid, myRoleCode]);

  const isRemoteTyping =
    (typingUsersByRoom.get(selectedConversation)?.size ?? 0) > 0;

  // ── Render helpers ────────────────────────────────────────────────────────

  const renderMediaPanel = (content: React.ReactNode) => (
    <Paper
      elevation={0}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        px: isMobile ? 1.25 : 2.5,
        pt: isMobile ? 1.25 : 2.25,
        pb: isMobile ? 1.25 : 1.75,
        display: "flex",
        flexDirection: "column",
        borderRadius: isMobile ? "16px" : "20px",
        border: "1px solid",
        borderColor: theme.palette.grey[200],
        backgroundColor: theme.palette.common.white,
        overflow: "hidden",
      }}
    >
      {content}
    </Paper>
  );

  if (roomsLoading) {
    return (
      <Box
        sx={{
          height: "calc(100vh - 120px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CircularProgress size={32} />
      </Box>
    );
  }

  if (isMobile) {
    return (
      <PageHeader
        title="Messagerie"
        caption="Un espace simple et sécurisé pour vos échanges."
      >
        {mobileView === "list" && (
          <Box
            sx={{
              width: "100%",
              minWidth: 0,
              height: `calc(100dvh - ${MOBILE_HEADER_HEIGHT}px - ${MOBILE_BOTTOM_NAV_HEIGHT}px - 120px)`,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <Box
                sx={{
                  flex: 1,
                  minHeight: 0,
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <ConversationsList
                  conversations={filteredConversations}
                  selectedConversation={selectedConversation}
                  searchTerm={searchTerm}
                  selectedDateFilter={selectedDateFilter}
                  activeFilters={activeFilters}
                  onFiltersChange={handleFiltersChange}
                  onSearchChange={handleSearchChange}
                  onDateFilterChange={handleDateFilterChange}
                  onSelect={handleSelectConversation}
                  showCreateGroupButton={iAmComptable}
                  onCreateGroup={() => setOpenCreateGroupModal(true)}
                  showManageGroupButton={iAmComptable}
                  onManageGroup={handleManageGroup}
                  badgeCounts={badgeCounts}
                  userRole={userRoleForFilters}
                  onLoadMore={handleLoadMoreConversations}
                  hasMore={hasMoreConversations}
                  isLoadingMore={roomsLoading && conversationsPage > 1}
                />
              </Box>
            </Box>
          </Box>
        )}

        {mobileView === "chat" && (
          <Box
            sx={{
              position: "fixed",
              inset: 0,
              zIndex: 1200,
              width: "100%",
              height: "100dvh",
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              backgroundColor: theme.palette.common.white,
            }}
          >
            {showEmptyState ? (
              <Box sx={{ flex: 1, minHeight: 0 }} />
            ) : (
              <ChatWindow
                key={selectedConversation}
                conversationId={selectedConversation}
                conversation={currentConversation}
                messages={currentMessages}
                isCommunicationConfirmed
                isRemoteTyping={isRemoteTyping}
                recipientType={recipientInfo.recipientType}
                recipientId={recipientInfo.recipientId}
                onTypingChange={(typing) =>
                  emitTyping(selectedConversation, typing)
                }
                onMessagesChange={handleMessagesChange}
                onSendFile={handleSendFile}
                onLoadMore={handleLoadOlderMessages}
                hasMore={hasMoreOlderMessages}
                isLoadingMore={isLoadingOlder}
                onMarkAsRead={handleMarkCurrentRoomAsRead}
                uploadProgress={uploadProgress}
                isUploading={isUploading}
                onOpenMedia={() => {
                  setMobileView("media");
                  onOpenMedia?.();
                }}
                onBack={() => setMobileView("list")}
              />
            )}
          </Box>
        )}

        {mobileView === "media" && (
          <Box
            sx={{
              position: "fixed",
              inset: 0,
              zIndex: 1200,
              width: "100%",
              height: "100dvh",
              minHeight: 0,
              display: "flex",
              overflow: "hidden",
              backgroundColor: theme.palette.common.white,
            }}
          >
            {renderMediaPanel(
              <SharedMediaView
                conversationId={selectedConversation}
                onBack={() => setMobileView("chat")}
              />,
            )}
          </Box>
        )}

        {/* Group Modals - Rendered outside main container for proper z-index */}
        <CreateGroupModal
          open={openCreateGroupModal}
          onClose={() => setOpenCreateGroupModal(false)}
          onCreate={handleCreateGroup}
          clients={groupModalClients}
          collaborators={groupModalCollaborators}
        />

        {selectedGroupForManagement && (
          <GroupManagementModal
            open={openManageGroupModal}
            onClose={() => {
              setOpenManageGroupModal(false);
              setSelectedGroupForManagement(null);
            }}
            groupId={selectedGroupForManagement}
            initialGroupName={
              allConversations.find((c) => c.id === selectedGroupForManagement)
                ?.name || ""
            }
            initialMembers={
              allConversations.find((c) => c.id === selectedGroupForManagement)
                ?.members || []
            }
            isAdmin={selectedGroupIsAdmin}
            clients={groupModalClients}
            collaborators={groupModalCollaborators}
            onUpdate={handleUpdateGroup}
          />
        )}
      </PageHeader>
    );
  }

  return (
    <PageHeader
      title="Messagerie"
      caption="Un espace simple et sécurisé pour vos échanges."
      sx={{
        overflow: "hidden", // Clips content
        height: "fit-content", // Ensures it doesn't expand unnecessarily
        maxHeight: "100%", // Prevents it from exceeding parent bounds
        overscrollBehavior: "none", // Prevents scroll-chaining to the parent
        touchAction: "none", // Disables swipe-to-scroll on mobile
      }}
    >
      <Box
        sx={{
          height: isMedium
            ? `calc(100vh - 400px - ${MOBILE_BOTTOM_NAV_HEIGHT}px)`
            : "calc(100vh - 215px)",
          minHeight: 0,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          // mt: isMedium
          //   ? `calc(100vh - 730px - ${MOBILE_BOTTOM_NAV_HEIGHT}px)`
          //   : "calc(100vh - 730px)",
        }}
      >
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            width: "100%",
            overflow: "hidden",
          }}
        >
          {desktopView === "media" ? (
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                width: "100%",
                display: "flex",
                overflow: "hidden",
              }}
            >
              {renderMediaPanel(
                <SharedMediaView
                  conversationId={selectedConversation}
                  onBack={() => setDesktopView("chat")}
                />,
              )}
            </Box>
          ) : (
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                gap: 2,
                width: "100%",
                overflow: "hidden",
              }}
            >
              <Paper
                elevation={0}
                sx={{
                  width: 360,
                  p: 1.75,
                  display: "flex",
                  flexDirection: "column",
                  borderRadius: "20px",
                  border: "1px solid",
                  borderColor: theme.palette.grey[200],
                  backgroundColor: theme.palette.common.white,
                  flexShrink: 0,
                  minHeight: 0,
                  overflow: "hidden",
                }}
              >
                <ConversationsList
                  conversations={filteredConversations}
                  selectedConversation={selectedConversation}
                  searchTerm={searchTerm}
                  selectedDateFilter={selectedDateFilter}
                  activeFilters={activeFilters}
                  onFiltersChange={handleFiltersChange}
                  onSearchChange={handleSearchChange}
                  onDateFilterChange={handleDateFilterChange}
                  onSelect={handleSelectConversation}
                  showCreateGroupButton={iAmComptable}
                  onCreateGroup={() => setOpenCreateGroupModal(true)}
                  showManageGroupButton={iAmComptable}
                  onManageGroup={handleManageGroup}
                  badgeCounts={badgeCounts}
                  userRole={userRoleForFilters}
                  onLoadMore={handleLoadMoreConversations}
                  hasMore={hasMoreConversations}
                  isLoadingMore={roomsLoading && conversationsPage > 1}
                />
              </Paper>

              <Paper
                elevation={0}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  px: 2.5,
                  pt: 2,
                  pb: 1.75,
                  display: "flex",
                  flexDirection: "column",
                  borderRadius: "20px",
                  border: "1px solid",
                  borderColor: theme.palette.grey[200],
                  backgroundColor: theme.palette.common.white,
                  overflow: "hidden",
                }}
              >
                {showEmptyState ? (
                  <Box sx={{ flex: 1, minHeight: 0 }} />
                ) : (
                  <ChatWindow
                    key={selectedConversation}
                    conversationId={selectedConversation}
                    conversation={currentConversation}
                    messages={currentMessages}
                    isCommunicationConfirmed
                    isRemoteTyping={isRemoteTyping}
                    recipientType={recipientInfo.recipientType}
                    recipientId={recipientInfo.recipientId}
                    onTypingChange={(typing) =>
                      emitTyping(selectedConversation, typing)
                    }
                    onMessagesChange={handleMessagesChange}
                    onSendFile={handleSendFile}
                    onLoadMore={handleLoadOlderMessages}
                    hasMore={hasMoreOlderMessages}
                    isLoadingMore={isLoadingOlder}
                    onMarkAsRead={handleMarkCurrentRoomAsRead}
                    uploadProgress={uploadProgress}
                    isUploading={isUploading}
                    onOpenMedia={() => {
                      setDesktopView("media");
                      onOpenMedia?.();
                    }}
                  />
                )}
              </Paper>
            </Box>
          )}
        </Box>
      </Box>

      {/* Group Modals - Rendered outside main container for proper z-index */}
      <CreateGroupModal
        open={openCreateGroupModal}
        onClose={() => setOpenCreateGroupModal(false)}
        onCreate={handleCreateGroup}
        clients={groupModalClients}
        collaborators={groupModalCollaborators}
      />

      {selectedGroupForManagement && (
        <GroupManagementModal
          open={openManageGroupModal}
          onClose={() => {
            setOpenManageGroupModal(false);
            setSelectedGroupForManagement(null);
          }}
          groupId={selectedGroupForManagement}
          initialGroupName={
            allConversations.find((c) => c.id === selectedGroupForManagement)
              ?.name || ""
          }
          initialMembers={
            allConversations.find((c) => c.id === selectedGroupForManagement)
              ?.members || []
          }
          isAdmin={selectedGroupIsAdmin}
          clients={groupModalClients}
          collaborators={groupModalCollaborators}
          onUpdate={handleUpdateGroup}
        />
      )}
    </PageHeader>
  );
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationGateway } from './notification.gateway';
import { MinioService } from '../../common/services/minio.service';

@Injectable()
export class NotificationService {
  constructor(
    private prisma: PrismaService,
    private notificationGateway: NotificationGateway,
    private minioService: MinioService
  ) {}

  /**
   * Create and send a notification
   */
  async createNotification(data: {
    recipientId: number;
    type: string;
    title: string;
    message: string;
    data?: any;
    actionUrl?: string;
    priority?: string;
  }) {
    const notification = await this.prisma.notification.create({
      data: {
        recipientId: data.recipientId,
        type: data.type,
        title: data.title,
        message: data.message,
        data: data.data ? JSON.stringify(data.data) : null,
        actionUrl: data.actionUrl ?? null,
        priority: data.priority ?? 'normal',
      },
      include: {
        recipient: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    // Send real-time notification via WebSocket
    this.notificationGateway.sendNotificationToUser(data.recipientId, notification);

    return notification;
  }

  /**
   * Get all notifications for a user
   */
  async getUserNotifications(
    userId: number,
    filters?: {
      read?: boolean;
      type?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    const where: any = { recipientId: userId };

    if (filters?.read !== undefined) {
      where.read = filters.read;
    }

    if (filters?.type) {
      where.type = filters.type;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filters?.limit || 50,
        skip: filters?.offset || 0,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: { recipientId: userId, read: false },
      }),
    ]);

    // Extraire les actorIds uniques depuis data JSON
    const parsedNotifications = notifications.map((n) => ({
      ...n,
      data: n.data ? JSON.parse(n.data) : null,
    }));

    const actorIds = [
      ...new Set(
        parsedNotifications
          .map((n) => n.data?.actorId)
          .filter((id): id is number => typeof id === 'number')
      ),
    ];

    // Récupérer les photos des acteurs
    const actorPhotoMap = new Map<number, string | null>();
    if (actorIds.length > 0) {
      const actors = await this.prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, photo: true },
      });

      await Promise.all(
        actors.map(async (actor) => {
          if (actor.photo) {
            try {
              const url = await this.minioService.getPresignedUrl(actor.photo, 7 * 24 * 60 * 60);
              actorPhotoMap.set(actor.id, url);
            } catch {
              actorPhotoMap.set(actor.id, actor.photo);
            }
          } else {
            actorPhotoMap.set(actor.id, null);
          }
        })
      );
    }

    return {
      notifications: parsedNotifications.map((n) => ({
        ...n,
        actorPhotoUrl: n.data?.actorId ? (actorPhotoMap.get(n.data.actorId) ?? null) : null,
        // actionUrl est déjà dans n via le spread, mais on le rend explicite
        actionUrl: n.actionUrl ?? null,
        // category pour grouper côté frontend
        category: n.type?.split('.')?.[0] ?? n.type,
      })),
      total,
      unreadCount,
    };
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: number, userId: number) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, recipientId: userId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        read: true,
      },
    });

    // Notify user about read status update
    this.notificationGateway.sendNotificationUpdate(userId, {
      notificationId,
      read: true,
    });

    return updated;
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(userId: number) {
    await this.prisma.notification.updateMany({
      where: { recipientId: userId, read: false },
      data: {
        read: true,
      },
    });

    // Notify user about bulk read
    this.notificationGateway.sendNotificationUpdate(userId, {
      allRead: true,
    });

    return { success: true };
  }

  /**
   * Delete a notification
   */
  async deleteNotification(notificationId: number, userId: number) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, recipientId: userId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    await this.prisma.notification.delete({
      where: { id: notificationId },
    });

    return { success: true };
  }

  /**
   * Get unread count
   */
  async getUnreadCount(userId: number) {
    const count = await this.prisma.notification.count({
      where: { recipientId: userId, read: false },
    });

    return { unreadCount: count };
  }

  /**
   * Emit a relationship update event via WebSocket (no DB record)
   */
  emitRelationshipUpdate(userId: number, payload: any) {
    this.notificationGateway.sendNotificationUpdate(userId, {
      type: 'relationship_update',
      ...payload,
    });
  }

  /**
   * Fonction dynamique pour créer n'importe quelle notification
   * Utilise des templates prédéfinis pour générer le contenu
   */
  async notify(params: {
    recipientId: number | number[];
    type: string;
    action: string;
    data?: any;
    actorName?: string;
    actorId?: number;
    priority?: string;
  }) {
    const {
      recipientId,
      type,
      action,
      data = {},
      actorName = 'Système',
      actorId,
      priority = 'normal',
    } = params;

    // Inclure actorId dans data pour pouvoir récupérer la photo plus tard
    const enrichedData = actorId ? { ...data, actorId } : data;

    // Templates de notifications
    const templates: Record<string, any> = {
      // Tasks
      'task.assigned': {
        title: 'Nouvelle tâche assignée',
        message: `${actorName} vous a assigné une nouvelle tâche`,
        actionUrl: `/tasks/${data.taskId}`,
        priority: 'normal',
      },
      'task.completed': {
        title: 'Tâche terminée',
        message: `${actorName} a terminé la tâche`,
        actionUrl: `/tasks/${data.taskId}`,
        priority: 'normal',
      },
      'task.updated': {
        title: 'Tâche mise à jour',
        message: `${actorName} a mis à jour une tâche`,
        actionUrl: `/tasks/${data.taskId}`,
        priority: 'low',
      },
      'task.validated': {
        title: 'Tâche validée',
        message: `${actorName} a validé votre tâche`,
        actionUrl: `/tasks/${data.taskId}`,
        priority: 'normal',
      },
      'task.in_review': {
        title: 'Tâche en révision',
        message: `${actorName} a soumis une tâche pour révision`,
        actionUrl: `/tasks/${data.taskId}`,
        priority: 'high',
      },
      'task.comment': {
        title: 'Nouveau commentaire',
        message: `${actorName} a commenté sur une tâche`,
        actionUrl: `/tasks/${data.taskId}`,
        priority: 'normal',
      },

      // Requests
      'request.created': {
        title: 'Nouvelle demande',
        message: `${actorName} a créé une nouvelle demande`,
        actionUrl: `/requests/${data.requestId}`,
        priority: 'high',
      },
      'request.updated': {
        title: 'Demande mise à jour',
        message: `${actorName} a mis à jour une demande`,
        actionUrl: `/requests/${data.requestId}`,
        priority: 'normal',
      },
      'request.responded': {
        title: 'Réponse à votre demande',
        message: `${actorName} a répondu à votre demande`,
        actionUrl: `/requests/${data.requestId}`,
        priority: 'high',
      },
      'request.status_changed': {
        title: 'Statut de demande mis à jour',
        message: `Votre demande est maintenant: ${data.status}`,
        actionUrl: `/requests/${data.requestId}`,
        priority: 'normal',
      },

      // Appointments
      'appointment.created': {
        title: 'Nouveau rendez-vous',
        message: `${actorName} a créé un rendez-vous avec vous`,
        actionUrl: `/meetings/${data.appointmentId}`,
        priority: 'high',
      },
      'appointment.confirmed': {
        title: 'Rendez-vous confirmé',
        message: `Votre rendez-vous a été confirmé par ${actorName}`,
        actionUrl: `/meetings/${data.appointmentId}`,
        priority: 'normal',
      },
      'appointment.rejected': {
        title: 'Rendez-vous refusé',
        message: `Votre rendez-vous a été refusé par ${actorName}`,
        actionUrl: `/meetings/${data.appointmentId}`,
        priority: 'high',
      },
      'appointment.rescheduled': {
        title: 'Rendez-vous reprogrammé',
        message: `${actorName} a reprogrammé le rendez-vous`,
        actionUrl: `/meetings/${data.appointmentId}`,
        priority: 'normal',
      },
      'appointment.cancelled': {
        title: 'Rendez-vous annulé',
        message: `${actorName} a annulé le rendez-vous`,
        actionUrl: `/meetings/${data.appointmentId}`,
        priority: 'high',
      },

      // Messages
      'message.received': {
        title: 'Nouveau message',
        message: `${actorName} vous a envoyé un message`,
        actionUrl: `/chat/${data.roomId || ''}`,
        priority: 'normal',
      },

      // Invoice extraction
      'invoice.extracted': {
        title: 'Extraction terminée',
        message: `L'extraction de la facture "${data.fileName || 'fichier'}" est terminée avec succès`,
        actionUrl: data.fileUrl || `/documents/${data.documentId}`,
        priority: 'normal',
      },
      'invoice.extraction_failed': {
        title: 'Extraction échouée',
        message: `L'extraction de la facture "${data.fileName || 'fichier'}" a échoué. Vous pouvez réessayer manuellement.`,
        actionUrl: data.fileUrl || `/documents/${data.documentId}`,
        priority: 'high',
      },

      // Relationships
      'relationship.invitation_received': {
        title: 'Nouvelle invitation de collaboration',
        message: `${actorName} vous invite à collaborer sur Finora.${data.invitationMessage ? ` Message : "${data.invitationMessage}"` : ''}`,
        actionUrl: `/relationships/invitations/${data.invitationId}`,
        priority: 'high',
      },
      'relationship.invitation_accepted': {
        title: 'Invitation acceptée ✅',
        message: `${actorName} a accepté votre demande de collaboration. La relation est maintenant active.`,
        actionUrl: `/relationships/active`,
        priority: 'normal',
      },
      'relationship.invitation_rejected': {
        title: 'Invitation refusée ❌',
        message: `${actorName} a refusé votre invitation.${data.rejectionReason ? ` Raison : "${data.rejectionReason}"` : ''}`,
        actionUrl: `/relationships/history`,
        priority: 'normal',
      },
      'relationship.terminated': {
        title: 'Relation résiliée',
        message: `${actorName} a résilié la relation professionnelle`,
        actionUrl: `/relationships`,
        priority: 'high',
      },
    };

    const templateKey = `${type}.${action}`;
    const template = templates[templateKey];

    if (!template) {
      throw new Error(`Template de notification non trouvé: ${templateKey}`);
    }

    // Support pour plusieurs destinataires
    const recipients = Array.isArray(recipientId) ? recipientId : [recipientId];

    // Créer les notifications pour tous les destinataires
    const notifications = await Promise.all(
      recipients.map((id) =>
        this.createNotification({
          recipientId: id,
          type,
          title: template.title,
          message: template.message,
          data: enrichedData,
          actionUrl: template.actionUrl,
          priority: priority || template.priority,
        })
      )
    );

    return notifications.length === 1 ? notifications[0] : notifications;
  }
}

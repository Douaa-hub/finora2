import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ChatService } from './chat.service';
import { CallService } from './call.service';
import { SendMessageDto } from './dto/send-message.dto';
import { JoinRoomDto } from './dto/join-room.dto';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private userSockets: Map<number, string[]> = new Map();
  private activeCalls: Map<number, number> = new Map();
  private callParticipants: Map<number, Set<number>> = new Map();
  private callTimeouts: Map<number, ReturnType<typeof setTimeout>> = new Map();
  // Tracks who is currently flagged as "typing" per room, so we can clear it on disconnect.
  private typingUsers: Map<number, Set<number>> = new Map();

  constructor(
    private chatService: ChatService,
    private callService: CallService,
    private jwtService: JwtService
  ) {}

  async handleConnection(client: Socket) {
    try {
      console.log(`[WebSocket] Client attempting to connect: ${client.id}`);

      // Extraire le token JWT
      const token =
        client.handshake.auth.token || client.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        console.log(`[WebSocket] No token provided, disconnecting client: ${client.id}`);
        client.disconnect();
        return;
      }

      // Vérifier le token
      console.log(`[WebSocket] Verifying JWT token...`);
      const payload = this.jwtService.verify(token);
      const userId = payload.id ?? payload.sub; // JWT puts id in payload.id, not payload.sub
      console.log(`[WebSocket] Token verified for user: ${userId}`);

      // Stocker la connexion
      client.data.userId = userId;

      const userSockets = this.userSockets.get(userId) || [];
      userSockets.push(client.id);
      this.userSockets.set(userId, userSockets);
      console.log(
        `[WebSocket] User ${userId} connected with ${userSockets.length} active socket(s)`
      );

      // Rejoindre automatiquement les salles de l'utilisateur
      console.log(`[WebSocket] Fetching rooms for user ${userId}...`);
      const rooms = await this.chatService.getUserRooms(userId);
      console.log(`[WebSocket] User ${userId} has ${rooms.length} room(s)`);

      rooms.forEach((room) => {
        client.join(`room:${room.id}`);
        console.log(`[WebSocket] User ${userId} joined room: ${room.id}`);
      });

      // Notifier les autres utilisateurs
      client.broadcast.emit('user:online', { userId });
      console.log(`[WebSocket] User ${userId} connection complete, notified others`);
    } catch (error) {
      console.error(`[WebSocket] Connection error for client ${client.id}:`, error.message);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId;

    if (userId) {
      const userSockets = this.userSockets.get(userId) || [];
      const updatedSockets = userSockets.filter((id) => id !== client.id);

      if (updatedSockets.length === 0) {
        this.userSockets.delete(userId);

        // Clear any "typing" indicator this user left behind and notify the
        // room(s) so peers don't see it stuck after an abrupt disconnect
        // (tab close, network loss, refresh).
        this.typingUsers.forEach((users, roomId) => {
          if (users.delete(userId)) {
            this.server.to(`room:${roomId}`).emit('user:typing', {
              roomId,
              userId,
              typing: false,
            });
          }
        });

        // If user was in any active calls, notify other participants
        this.callParticipants.forEach((participants, roomId) => {
          if (participants.has(userId)) {
            participants.delete(userId);

            // Notify other participants that this user left
            participants.forEach((participantId) => {
              const targetSockets = this.userSockets.get(participantId);
              targetSockets?.forEach((socketId) => {
                this.server.to(socketId).emit('call:user-left', {
                  userId,
                  roomId,
                });
              });
            });

            // Clean up the call if no one is left OR it's a 1:1 call —
            // same rule as handleCallEnd, so an abrupt disconnect (tab
            // closed, network lost) ends a 1:1 call for the remaining
            // participant instead of leaving them stuck on "waiting".
            const callId = this.activeCalls.get(roomId);
            if (callId) {
              this.callService
                .getCallById(callId)
                .then((call) => {
                  const isOneOnOneCall = (call?.participants?.length ?? 0) <= 2;
                  if (participants.size !== 0 && !isOneOnOneCall) return;

                  const wasNeverAnswered = call?.status === 'initiated';
                  const finish = wasNeverAnswered
                    ? this.callService.cancelCall(callId)
                    : this.callService.endCall(callId, 0);

                  return finish.then(() => {
                    this.activeCalls.delete(roomId);
                    this.callParticipants.delete(roomId);
                    this.server.to(`room:${roomId}`).emit('call:ended', {
                      endedBy: userId,
                      roomId,
                      callEnded: true,
                    });
                  });
                })
                .catch(() => {
                  // Error ending call on disconnect
                });
            }
          }
        });

        // Notifier que l'utilisateur est offline
        client.broadcast.emit('user:offline', { userId });
      } else {
        this.userSockets.set(userId, updatedSockets);
      }
    }
  }

  @SubscribeMessage('room:join')
  async handleJoinRoom(@ConnectedSocket() client: Socket, @MessageBody() data: JoinRoomDto) {
    try {
      const userId = client.data.userId;
      const room = await this.chatService.getRoomById(data.roomId, userId);

      client.join(`room:${data.roomId}`);

      // Notifier les autres participants
      client.to(`room:${data.roomId}`).emit('room:user-joined', {
        roomId: data.roomId,
        userId,
      });

      return { success: true, room };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('room:leave')
  async handleLeaveRoom(@ConnectedSocket() client: Socket, @MessageBody() data: JoinRoomDto) {
    try {
      const userId = client.data.userId;

      client.leave(`room:${data.roomId}`);

      // Notifier les autres participants
      client.to(`room:${data.roomId}`).emit('room:user-left', {
        roomId: data.roomId,
        userId,
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('message:send')
  async handleSendMessage(@ConnectedSocket() client: Socket, @MessageBody() data: SendMessageDto) {
    try {
      const userId = client.data.userId;
      const message = await this.chatService.sendMessage(userId, data);

      // Envoyer le message à tous les participants de la salle
      this.server.to(`room:${data.roomId}`).emit('message:new', message);

      // Envoyer des notifications aux utilisateurs mentionnés
      if (data.mentions && data.mentions.length > 0) {
        data.mentions.forEach((mentionedUserId) => {
          const sockets = this.userSockets.get(mentionedUserId);
          if (sockets) {
            sockets.forEach((socketId) => {
              this.server.to(socketId).emit('message:mention', {
                message,
                mentionedBy: userId,
              });
            });
          }
        });
      }

      return { success: true, message };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('message:edit')
  async handleEditMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: number; content: string }
  ) {
    try {
      const userId = client.data.userId;
      const message = await this.chatService.editMessage(data.messageId, userId, data.content);

      // Notifier tous les participants de la salle
      if (message.roomId) {
        this.server.to(`room:${message.roomId}`).emit('message:updated', message);
      }

      return { success: true, message };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('message:delete')
  async handleDeleteMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: number }
  ) {
    try {
      const userId = client.data.userId;

      const result = await this.chatService.deleteMessage(data.messageId, userId);

      this.server.to(`room:${result.roomId}`).emit('message:deleted', {
        messageId: data.messageId,
        roomId: result.roomId,
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('typing:start')
  async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: number }
  ) {
    const userId = client.data.userId;

    try {
      // Même vérification d'appartenance que handleJoinRoom : lève une
      // exception si la room n'existe pas ou si l'utilisateur n'en fait pas partie.
      await this.chatService.getRoomById(data.roomId, userId);
    } catch {
      return;
    }

    const roomTypers = this.typingUsers.get(data.roomId) || new Set<number>();
    roomTypers.add(userId);
    this.typingUsers.set(data.roomId, roomTypers);

    client.to(`room:${data.roomId}`).emit('user:typing', {
      roomId: data.roomId,
      userId,
      typing: true,
    });
  }

  @SubscribeMessage('typing:stop')
  async handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: number }
  ) {
    const userId = client.data.userId;

    try {
      await this.chatService.getRoomById(data.roomId, userId);
    } catch {
      return;
    }

    this.typingUsers.get(data.roomId)?.delete(userId);

    client.to(`room:${data.roomId}`).emit('user:typing', {
      roomId: data.roomId,
      userId,
      typing: false,
    });
  }

  @SubscribeMessage('message:read')
  async handleMarkAsRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: number }
  ) {
    try {
      const userId = client.data.userId;
      await this.chatService.markAsRead(data.messageId, userId);

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('call:initiate')
  async handleCallInitiate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      callType: 'audio' | 'video';
      participants: number[];
      isGroup?: boolean;
    }
  ) {
    try {
      const userId = client.data.userId;

      const call = await this.callService.createCall({
        roomId: data.roomId,
        initiatorId: userId,
        callType: data.callType,
        participants: data.participants.map((p) => p.toString()),
      });

      this.activeCalls.set(data.roomId, call.id);

      // Track the initiator as the first participant in the call
      const participants = new Set<number>([userId]);
      this.callParticipants.set(data.roomId, participants);

      // For group calls: set timeout to stop ringing (not end call)
      // For 1:1 calls: set timeout to mark as missed and end call
      const isGroupCall = data.isGroup || data.participants.length > 2;

      // For group calls: immediately mark as ongoing and send message
      if (isGroupCall) {
        await this.callService.updateCallStatus(call.id, 'ongoing');

        // Send "call started" message immediately
        const callMessage = await this.chatService.sendMessage(userId, {
          roomId: data.roomId,
          content: `${call.callType === 'video' ? 'Appel vidéo' : 'Appel vocal'} en cours`,
          type: 'call',
          callId: call.id,
        });

        // Broadcast to room
        this.server.to(`room:${data.roomId}`).emit('message:new', callMessage);

        // Also send to the initiator (they're not in the room broadcast)
        const initiatorSockets = this.userSockets.get(userId);
        initiatorSockets?.forEach((socketId) => {
          this.server.to(socketId).emit('message:new', callMessage);
        });
      }

      const timeout = setTimeout(async () => {
        const stillActive = this.activeCalls.get(data.roomId);
        const currentParticipants = this.callParticipants.get(data.roomId);

        if (stillActive === call.id) {
          try {
            if (isGroupCall) {
              // Group call: just stop ringing, call continues
            } else {
              // 1:1 call: mark as missed and end if no one joined
              if (!currentParticipants || currentParticipants.size <= 1) {
                await this.callService.markCallAsMissed(call.id);
                this.activeCalls.delete(data.roomId);
                this.callParticipants.delete(data.roomId);

                const missedCallMessage = await this.chatService.sendMessage(userId, {
                  roomId: data.roomId,
                  content: `${call.callType === 'video' ? 'Appel vidéo' : 'Appel vocal'} manqué`,
                  type: 'call',
                  callId: call.id,
                });

                this.server.to(`room:${data.roomId}`).emit('message:new', missedCallMessage);

                // Notify caller that call was missed
                const callerSockets = this.userSockets.get(userId);
                callerSockets?.forEach((socketId) => {
                  this.server.to(socketId).emit('call:missed', {
                    roomId: data.roomId,
                    callId: call.id,
                  });
                });
              }
            }

            this.callTimeouts.delete(data.roomId);
          } catch {
            // Error handling timeout
          }
        }
      }, 30000);

      this.callTimeouts.set(data.roomId, timeout);

      // Notify all participants (ring them)
      data.participants.forEach((participantId) => {
        if (participantId !== userId) {
          const targetSockets = this.userSockets.get(participantId);

          if (targetSockets && targetSockets.length > 0) {
            targetSockets.forEach((socketId) => {
              this.server.to(socketId).emit('call:incoming', {
                callId: call.id,
                callerId: userId,
                roomId: data.roomId,
                callType: data.callType,
                initiatorName: `${call.initiator.firstName} ${call.initiator.lastName}`,
                isGroup: isGroupCall,
              });
            });
          }
        }
      });

      return { success: true, callId: call.id };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('call:offer')
  handleCallOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      targetUserId: number;
      offer: any;
    }
  ) {
    const userId = client.data.userId;

    const targetSockets = this.userSockets.get(data.targetUserId);
    targetSockets?.forEach((socketId) => {
      this.server.to(socketId).emit('call:offer', {
        callerId: userId,
        roomId: data.roomId,
        offer: data.offer,
      });
    });

    return { success: true };
  }

  @SubscribeMessage('call:answer')
  handleCallAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      targetUserId: number;
      answer: any;
    }
  ) {
    const userId = client.data.userId;

    const targetSockets = this.userSockets.get(data.targetUserId);
    targetSockets?.forEach((socketId) => {
      this.server.to(socketId).emit('call:answer', {
        callerId: userId,
        roomId: data.roomId,
        answer: data.answer,
      });
    });

    return { success: true };
  }

  @SubscribeMessage('call:ice-candidate')
  handleIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      targetUserId: number;
      candidate: any;
    }
  ) {
    const userId = client.data.userId;

    const targetSockets = this.userSockets.get(data.targetUserId);
    targetSockets?.forEach((socketId) => {
      this.server.to(socketId).emit('call:ice-candidate', {
        callerId: userId,
        roomId: data.roomId,
        candidate: data.candidate,
      });
    });

    return { success: true };
  }

  @SubscribeMessage('call:accept')
  async handleCallAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      callerId: number;
      callId?: number;
    }
  ) {
    try {
      const userId = client.data.userId;

      const callId = data.callId || this.activeCalls.get(data.roomId);
      if (callId) {
        await this.callService.updateCallStatus(callId, 'ongoing');

        // Clear the missed call timeout
        const timeout = this.callTimeouts.get(data.roomId);
        if (timeout) {
          clearTimeout(timeout);
          this.callTimeouts.delete(data.roomId);
        }
      }

      // Get user info for the newly joined user
      const newUserInfo = await this.chatService.getUserById(userId);
      const newUserName = newUserInfo
        ? `${newUserInfo.firstName} ${newUserInfo.lastName}`
        : `User ${userId}`;

      // Add this user to the active call participants
      const participants = this.callParticipants.get(data.roomId);
      if (participants) {
        participants.add(userId);
      }

      // Notify the caller that their call was accepted
      const callerSockets = this.userSockets.get(data.callerId);
      callerSockets?.forEach((socketId) => {
        this.server.to(socketId).emit('call:accepted', {
          acceptedBy: userId,
          roomId: data.roomId,
          userName: newUserName,
        });
      });

      // Send existing participants info to the newly joined user
      // This creates a mesh network where everyone connects to everyone
      if (participants && participants.size > 1) {
        const existingParticipants = Array.from(participants)
          .filter((pId) => pId !== userId)
          .map(async (pId) => {
            const user = await this.chatService.getUserById(pId);
            return {
              userId: pId,
              userName: user ? `${user.firstName} ${user.lastName}` : `User ${pId}`,
            };
          });

        const participantsInfo = await Promise.all(existingParticipants);

        const newUserSockets = this.userSockets.get(userId);
        newUserSockets?.forEach((socketId) => {
          this.server.to(socketId).emit('call:existing-participants', {
            participants: participantsInfo,
          });
        });
      }

      // Notify ALL other active participants that a new user joined
      // This is crucial for group calls - existing participants need to establish connections
      if (participants) {
        participants.forEach((participantId) => {
          if (participantId !== userId) {
            const targetSockets = this.userSockets.get(participantId);
            targetSockets?.forEach((socketId) => {
              this.server.to(socketId).emit('call:user-joined', {
                userId,
                roomId: data.roomId,
                userName: newUserName,
              });
            });
          }
        });
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('call:reject')
  async handleCallReject(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      callerId: number;
      callId?: number;
      isGroup?: boolean;
    }
  ) {
    try {
      const userId = client.data.userId;

      const callId = data.callId || this.activeCalls.get(data.roomId);
      const participants = this.callParticipants.get(data.roomId);

      // For group calls: rejection is just dismissing the notification
      if (data.isGroup) {
        return { success: true, dismissed: true };
      }

      // For 1:1 calls: only end if initiator is alone
      if (callId) {
        const hasOtherParticipants = participants && participants.size > 1;

        if (!hasOtherParticipants) {
          // 1:1 call with no other participants - end the entire call
          const timeout = this.callTimeouts.get(data.roomId);
          if (timeout) {
            clearTimeout(timeout);
            this.callTimeouts.delete(data.roomId);
          }

          const call = await this.callService.markCallAsRejected(callId);
          this.activeCalls.delete(data.roomId);
          this.callParticipants.delete(data.roomId);

          // Create a system message for the rejected call - sent from the initiator
          const callMessage = await this.chatService.sendMessage(call.initiatorId, {
            roomId: data.roomId,
            content: `${call.callType === 'video' ? 'Appel vidéo' : 'Appel vocal'} refusé`,
            type: 'call',
            callId: call.id,
          });

          this.server.to(`room:${data.roomId}`).emit('message:new', callMessage);

          // Notify caller that call was rejected and ended
          const callerSockets = this.userSockets.get(data.callerId);
          callerSockets?.forEach((socketId) => {
            this.server.to(socketId).emit('call:rejected', {
              rejectedBy: userId,
              roomId: data.roomId,
              callEnded: true,
            });
          });
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('call:join')
  async handleCallJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      callId: number;
    }
  ) {
    try {
      const userId = client.data.userId;

      // Verify call is still active
      const activeCallId = this.activeCalls.get(data.roomId);
      if (!activeCallId || activeCallId !== data.callId) {
        return { success: false, error: 'Call is no longer active' };
      }

      // Add user to participants immediately (but don't notify others yet)
      const participants = this.callParticipants.get(data.roomId);
      if (participants) {
        participants.add(userId);
      }

      // Update call status to ongoing if it was still initiated
      await this.callService.updateCallStatus(data.callId, 'ongoing');

      // Get call info to return call type
      const callInfo = await this.callService.getCallById(data.callId);

      // Return call type so client can start media stream
      // Client will emit 'call:ready' once media is ready
      return { success: true, callType: callInfo?.callType || 'video' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('call:ready')
  async handleCallReady(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      callId: number;
    }
  ) {
    try {
      const userId = client.data.userId;

      // Verify call is still active
      const activeCallId = this.activeCalls.get(data.roomId);
      if (!activeCallId || activeCallId !== data.callId) {
        return { success: false, error: 'Call is no longer active' };
      }

      // Get user info
      const userInfo = await this.chatService.getUserById(userId);
      const userName = userInfo ? `${userInfo.firstName} ${userInfo.lastName}` : `User ${userId}`;

      const participants = this.callParticipants.get(data.roomId);

      // Notify all existing participants that this user is ready
      if (participants) {
        participants.forEach((participantId) => {
          if (participantId !== userId) {
            const targetSockets = this.userSockets.get(participantId);
            targetSockets?.forEach((socketId) => {
              this.server.to(socketId).emit('call:user-joined', {
                userId,
                roomId: data.roomId,
                userName,
              });
            });
          }
        });
      }

      // Send existing participants info to the newly joined user
      if (participants && participants.size > 1) {
        const existingParticipants = Array.from(participants)
          .filter((pId) => pId !== userId)
          .map(async (pId) => {
            const user = await this.chatService.getUserById(pId);
            return {
              userId: pId,
              userName: user ? `${user.firstName} ${user.lastName}` : `User ${pId}`,
            };
          });

        const participantsInfo = await Promise.all(existingParticipants);

        const newUserSockets = this.userSockets.get(userId);
        newUserSockets?.forEach((socketId) => {
          this.server.to(socketId).emit('call:existing-participants', {
            participants: participantsInfo,
          });
        });
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('call:end')
  async handleCallEnd(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: number;
      participants: number[];
      duration?: number;
      callId?: number;
    }
  ) {
    try {
      const userId = client.data.userId;

      const callId = data.callId || this.activeCalls.get(data.roomId);
      const participants = this.callParticipants.get(data.roomId);

      if (callId && participants) {
        // Remove this user from participants
        participants.delete(userId);

        // Notify others that this user left
        participants.forEach((participantId) => {
          const targetSockets = this.userSockets.get(participantId);
          targetSockets?.forEach((socketId) => {
            this.server.to(socketId).emit('call:user-left', {
              userId,
              roomId: data.roomId,
            });
          });
        });

        // Fetch the call once — used both to distinguish "cancelled before
        // pickup" from a real hangup, and to detect whether this is a 1:1
        // call (participants.length <= 2 at creation time).
        const preEndCall = await this.callService.getCallById(callId);
        const wasNeverAnswered = preEndCall?.status === 'initiated';

        // 1:1 calls must end for BOTH parties the instant either one hangs
        // up (Messenger/WhatsApp semantics) — waiting for "everyone left"
        // only makes sense for group calls, where other participants may
        // still be talking after one person exits.
        const isOneOnOneCall = (preEndCall?.participants?.length ?? 0) <= 2;

        // End the call if no one is left OR it's a 1:1 call being hung up
        if (participants.size === 0 || isOneOnOneCall) {
          // Clear timeout
          const timeout = this.callTimeouts.get(data.roomId);
          if (timeout) {
            clearTimeout(timeout);
            this.callTimeouts.delete(data.roomId);
          }

          const call = wasNeverAnswered
            ? await this.callService.cancelCall(callId)
            : await this.callService.endCall(callId, data.duration || 0);
          this.activeCalls.delete(data.roomId);
          this.callParticipants.delete(data.roomId);

          // Find and update the existing "ongoing" message instead of creating a new one
          const existingMessages = await this.chatService.getRoomMessagesForCallUpdate(
            data.roomId,
            callId
          );

          // Find the ongoing call message
          const ongoingMessage = existingMessages.find(
            (msg) => msg.callId === callId && msg.type === 'call'
          );

          const duration = data.duration || 0;
          const minutes = Math.floor(duration / 60);
          const seconds = duration % 60;
          const durationText =
            duration > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : '0:00';
          const callTypeLabel = call.callType === 'video' ? 'Appel vidéo' : 'Appel vocal';
          const endedContent = wasNeverAnswered
            ? `${callTypeLabel} annulé`
            : `${callTypeLabel} - ${durationText}`;
          const finalStatus = wasNeverAnswered ? 'cancelled' : 'completed';

          if (ongoingMessage) {
            // Group calls (and any call that already got a "started"/"ongoing"
            // message) — update that message in place.
            await this.chatService.updateMessage(ongoingMessage.id, {
              content: endedContent,
            });

            // Broadcast to entire room
            this.server.to(`room:${data.roomId}`).emit('call:message-updated', {
              messageId: ongoingMessage.id,
              roomId: data.roomId,
              callId: call.id,
              status: finalStatus,
              duration: data.duration || 0,
              content: endedContent,
            });

            // Also send to ALL participants directly (including the one who ended)
            const allParticipantIds = Array.from(this.callParticipants.get(data.roomId) || []);
            allParticipantIds.push(userId);

            allParticipantIds.forEach((participantId) => {
              const sockets = this.userSockets.get(participantId);
              sockets?.forEach((socketId) => {
                this.server.to(socketId).emit('call:message-updated', {
                  messageId: ongoingMessage.id,
                  roomId: data.roomId,
                  callId: call.id,
                  status: finalStatus,
                  duration: data.duration || 0,
                  content: endedContent,
                });
              });
            });
          } else {
            // 1:1 calls never get a "started"/"ongoing" message (only group
            // calls do, at call:initiate) — so there is nothing to update.
            // Create the completion card directly instead of silently
            // dropping it.
            const callMessage = await this.chatService.sendMessage(call.initiatorId, {
              roomId: data.roomId,
              content: endedContent,
              type: 'call',
              callId: call.id,
            });

            this.server.to(`room:${data.roomId}`).emit('message:new', callMessage);
          }

          // Notify all room members that call ended (this.server, not
          // client.to, so it also reaches other tabs/devices of the user
          // who just hung up).
          this.server.to(`room:${data.roomId}`).emit('call:ended', {
            endedBy: userId,
            roomId: data.roomId,
            callEnded: true,
          });
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

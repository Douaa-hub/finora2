import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFiles,
  ParseIntPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { CreateRoomDto } from './dto/create-room.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SearchMessagesDto } from './dto/search-messages.dto';
import { GetRoomsDto } from './dto/get-rooms.dto';

@ApiTags('Chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway
  ) {}

  // ==================== ROOMS ====================

  @Post('rooms/direct')
  @ApiOperation({ summary: 'Find or create a direct chat room between two users' })
  @ApiResponse({ status: 200, description: 'Direct room found or created' })
  async findOrCreateDirectRoom(
    @Request() req,
    @Body('targetUserId', ParseIntPipe) targetUserId: number
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.findOrCreateDirectRoom(Number(userId), targetUserId);
  }

  @Post('rooms/backfill')
  @ApiOperation({ summary: 'Backfill: create missing direct rooms for all existing contacts' })
  @ApiResponse({ status: 200, description: 'Backfill completed' })
  async backfillDirectRooms(@Request() req) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.backfillDirectRooms(Number(userId));
  }

  @Post('rooms')
  @ApiOperation({ summary: 'Créer une salle de chat' })
  @ApiResponse({ status: 201, description: 'Salle créée avec succès' })
  async createRoom(@Request() req, @Body() dto: CreateRoomDto) {
    const userId = req.user?.id ?? req.user?.sub;
    const room = await this.chatService.createRoom(Number(userId), dto);
    // room.participants is string[] (Prisma ChatRoom.participants) — join
    // each participant's already-connected socket(s) to the new room so
    // message:new reaches them from the very first message, without
    // waiting for their next reconnect.
    room.participants.forEach((participantId) => {
      this.chatGateway.joinUserToRoom(Number(participantId), room.id);
    });
    return room;
  }

  @Get('rooms')
  @ApiOperation({ summary: "Obtenir toutes les salles de l'utilisateur" })
  @ApiResponse({ status: 200, description: 'Liste des salles' })
  async getUserRooms(@Request() req, @Query() query: GetRoomsDto) {
    const userId = req.user?.id ?? req.user?.sub;

    // Support both legacy 'category' and new 'categories' array
    const categoriesToUse = query.categories || (query.category ? [query.category] : undefined);

    return this.chatService.getUserRoomsDebug(
      Number(userId),
      query.category,
      query.search,
      query.date,
      query.page || 1,
      query.pageSize || 50,
      categoriesToUse,
      query.unreadOnly
    );
  }

  // ⚠️ Must be declared BEFORE @Get('rooms/:id') to avoid NestJS matching "messages" as :id
  @Get('rooms/:id/messages')
  @ApiOperation({ summary: "Obtenir les messages d'une salle" })
  @ApiResponse({ status: 200, description: 'Liste des messages' })
  async getRoomMessages(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limit?: string,
    @Query('page') page?: string
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.getRoomMessages(
      id,
      Number(userId),
      limit ? parseInt(limit, 10) : 50,
      page ? parseInt(page, 10) : 1
    );
  }

  @Get('rooms/:id/shared-documents')
  @ApiOperation({ summary: "Obtenir les documents partagés d'une salle" })
  @ApiResponse({ status: 200, description: 'Documents partagés paginés' })
  async getSharedDocuments(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.getSharedDocuments(
      id,
      Number(userId),
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 20
    );
  }

  @Post('rooms/:id/read')
  @ApiOperation({ summary: "Marquer tous les messages d'une room comme lus" })
  @ApiResponse({ status: 200, description: 'Room marquée comme lue' })
  async markRoomAsRead(@Request() req, @Param('id', ParseIntPipe) id: number) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.markRoomAsRead(id, Number(userId));
  }

  @Get('rooms/:id')
  @ApiOperation({ summary: 'Obtenir une salle par ID' })
  @ApiResponse({ status: 200, description: 'Détails de la salle' })
  async getRoomById(@Request() req, @Param('id', ParseIntPipe) id: number) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.getRoomById(id, Number(userId));
  }

  @Patch('rooms/:id')
  @ApiOperation({ summary: 'Mettre à jour une salle (nom)' })
  @ApiResponse({ status: 200, description: 'Salle mise à jour' })
  async updateRoom(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body('name') name?: string
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.updateRoom(id, Number(userId), { name });
  }

  @Post('rooms/:id/participants')
  @ApiOperation({ summary: 'Ajouter un participant à une salle' })
  @ApiResponse({ status: 200, description: 'Participant ajouté' })
  async addParticipant(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body('participantId', ParseIntPipe) participantId: number
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    const result = await this.chatService.addParticipant(id, Number(userId), participantId);
    this.chatGateway.joinUserToRoom(participantId, id);
    return result;
  }

  @Delete('rooms/:id/participants/:participantId')
  @ApiOperation({ summary: "Retirer un participant d'une salle" })
  @ApiResponse({ status: 200, description: 'Participant retiré' })
  async removeParticipant(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Param('participantId', ParseIntPipe) participantId: number
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.removeParticipant(id, Number(userId), participantId);
  }

  // ==================== MESSAGES ====================

  @Get('messages/search')
  @ApiOperation({ summary: 'Rechercher dans les messages' })
  @ApiResponse({ status: 200, description: 'Résultats de recherche' })
  async searchMessages(@Request() req, @Query() dto: SearchMessagesDto) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.searchMessages(Number(userId), dto);
  }

  @Post('messages')
  @ApiOperation({ summary: 'Envoyer un message' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'Message envoyé' })
  @UseInterceptors(FilesInterceptor('attachments', 10))
  async sendMessage(
    @Request() req,
    @Body() dto: SendMessageDto,
    @UploadedFiles() files?: Express.Multer.File[]
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    const message = await this.chatService.sendMessage(Number(userId), dto, files);
    // Broadcast to all room participants via socket so both sides receive in real-time
    this.chatGateway.server.to(`room:${dto.roomId}`).emit('message:new', message);
    return message;
  }

  @Put('messages/:id')
  @ApiOperation({ summary: 'Modifier un message' })
  @ApiResponse({ status: 200, description: 'Message modifié' })
  async editMessage(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body('content') content: string
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    const message = await this.chatService.editMessage(id, Number(userId), content);
    // Broadcast to all room participants so the edit is visible in real-time
    if (message.roomId) {
      this.chatGateway.server.to(`room:${message.roomId}`).emit('message:updated', message);
    }
    return message;
  }

  @Delete('messages/:id')
  @ApiOperation({ summary: 'Supprimer un message' })
  @ApiResponse({ status: 200, description: 'Message supprimé' })
  async deleteMessage(@Request() req, @Param('id', ParseIntPipe) id: number) {
    const userId = req.user?.id ?? req.user?.sub;
    const result = await this.chatService.deleteMessage(id, Number(userId));

    // Keep realtime state in sync for clients connected via WebSocket
    if (result?.roomId) {
      this.chatGateway.server.to(`room:${result.roomId}`).emit('message:deleted', {
        messageId: id,
        roomId: result.roomId,
      });
    }

    return result;
  }

  @Post('messages/:id/read')
  @ApiOperation({ summary: 'Marquer un message comme lu' })
  @ApiResponse({ status: 200, description: 'Message marqué comme lu' })
  async markAsRead(@Request() req, @Param('id', ParseIntPipe) id: number) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.markAsRead(id, Number(userId));
  }

  @Get('messages/recent')
  @ApiOperation({ summary: 'Get last 3 messages across all user rooms' })
  @ApiResponse({ status: 200, description: 'Recent messages with unread count' })
  async getRecentMessages(@Request() req) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.getRecentMessages(Number(userId), 3);
  }

  @Get('messages/unread-count')
  @ApiOperation({ summary: 'Get total unread messages count' })
  @ApiResponse({ status: 200, description: 'Total unread messages count' })
  async getUnreadMessagesCount(@Request() req) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.getUnreadMessagesCount(Number(userId));
  }

  @Post('rooms/mark-all-read')
  @ApiOperation({ summary: 'Mark all rooms as read for current user' })
  @ApiResponse({ status: 200, description: 'All messages marked as read' })
  async markAllRoomsAsRead(@Request() req) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.markAllRoomsAsRead(Number(userId));
  }

  // ==================== THREADS ====================

  @Post('threads')
  @ApiOperation({ summary: 'Créer un thread de discussion' })
  @ApiResponse({ status: 201, description: 'Thread créé' })
  async createThread(
    @Request() req,
    @Body('title') title: string,
    @Body('contextType') contextType?: string,
    @Body('contextId') contextId?: number
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.createThread(Number(userId), title, contextType, contextId);
  }

  @Get('threads/:id/messages')
  @ApiOperation({ summary: "Obtenir les messages d'un thread" })
  @ApiResponse({ status: 200, description: 'Messages du thread' })
  async getThreadMessages(@Request() req, @Param('id', ParseIntPipe) id: number) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.chatService.getThreadMessages(id, Number(userId));
  }
}

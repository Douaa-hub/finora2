import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class CallService {
  constructor(private prisma: PrismaService) {}

  async createCall(data: {
    roomId: number;
    initiatorId: number;
    callType: 'audio' | 'video';
    participants: string[];
  }) {
    return this.prisma.call.create({
      data: {
        roomId: data.roomId,
        initiatorId: data.initiatorId,
        callType: data.callType,
        participants: data.participants,
        status: 'initiated',
      },
      include: {
        initiator: {
          select: {
            id: true,
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
          },
        },
      },
    });
  }

  async updateCallStatus(
    callId: number,
    status: 'initiated' | 'ongoing' | 'completed' | 'missed' | 'rejected'
  ) {
    return this.prisma.call.update({
      where: { id: callId },
      data: { status },
    });
  }

  async endCall(callId: number, duration: number) {
    return this.prisma.call.update({
      where: { id: callId },
      data: {
        status: 'completed',
        endedAt: new Date(),
        duration,
      },
      include: {
        initiator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });
  }

  async markCallAsMissed(callId: number) {
    return this.prisma.call.update({
      where: { id: callId },
      data: {
        status: 'missed',
        endedAt: new Date(),
      },
      include: {
        initiator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });
  }

  async markCallAsRejected(callId: number) {
    return this.prisma.call.update({
      where: { id: callId },
      data: {
        status: 'rejected',
        endedAt: new Date(),
      },
      include: {
        initiator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });
  }

  // The initiator hung up before the callee ever answered (call never left
  // the "initiated" status) — distinct from a normal hangup after a real
  // conversation happened, which is recorded via endCall/"completed".
  async cancelCall(callId: number) {
    return this.prisma.call.update({
      where: { id: callId },
      data: {
        status: 'cancelled',
        endedAt: new Date(),
      },
      include: {
        initiator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });
  }

  async getCallHistory(roomId: number, limit = 20, offset = 0) {
    return this.prisma.call.findMany({
      where: { roomId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        initiator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            photo: true,
          },
        },
      },
    });
  }

  async getUserCallHistory(userId: number, limit = 20, offset = 0) {
    return this.prisma.call.findMany({
      where: {
        OR: [{ initiatorId: userId }, { participants: { has: userId.toString() } }],
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        initiator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            photo: true,
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
    });
  }

  async getCallById(callId: number) {
    return this.prisma.call.findUnique({
      where: { id: callId },
      include: {
        initiator: {
          select: {
            id: true,
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
          },
        },
      },
    });
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { AppointmentService } from './appointment.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { MailService } from '../mail/mail.service';

describe('AppointmentService', () => {
  let service: AppointmentService;

  const prismaMock = {
    user: {
      findUnique: jest.fn(),
    },
    availability: {
      findFirst: jest.fn(),
    },
    appointment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  const notificationServiceMock = {
    notify: jest.fn().mockResolvedValue(undefined),
  };

  const mailServiceMock = {
    sendAppointmentGuestInvitation: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppointmentService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: NotificationService, useValue: notificationServiceMock },
        { provide: MailService, useValue: mailServiceMock },
      ],
    }).compile();

    service = module.get<AppointmentService>(AppointmentService);
  });

  describe('6.3.4 - Création d’un rendez-vous', () => {
    it('devrait créer un rendez-vous avec des données valides', async () => {
      const userId = 1;

      const dto: any = {
        title: 'Réunion comptable',
        description: 'Discussion autour du dossier fiscal',
        date: '2026-06-15',
        hour: '10:00',
        accountantId: 2,
        clientId: 1,
        meetingType: 'online',
        location: 'Google Meet',
        clientNotes: 'Préparer les documents nécessaires',
        guests: [],
      };

      prismaMock.user.findUnique.mockResolvedValue({
        companyId: 10,
        role: 'CLIENT',
      });

      prismaMock.availability.findFirst.mockResolvedValue({
        id: 1,
        accountantId: 2,
        isActive: true,
        isRecurring: true,
        dayOfWeek: 'lundi',
        startTime: '09:00',
        endTime: '12:00',
        slotDuration: 60,
      });

      prismaMock.appointment.create.mockResolvedValue({
        id: 100,
        ...dto,
        date: new Date('2026-06-15T00:00:00.000Z'),
        status: 'pending',
        companyId: 10,
        client: {
          id: 1,
          firstName: 'Client',
          lastName: 'Test',
        },
        accountant: {
          id: 2,
          firstName: 'Comptable',
          lastName: 'Test',
        },
      });

      const result = await service.createAppointment(dto, userId);
      const data = result.data as any;

      expect(result.success).toBe(true);
      expect(data.id).toBe(100);
      expect(data.title).toBe('Réunion comptable');
      expect(prismaMock.availability.findFirst).toHaveBeenCalled();
      expect(prismaMock.appointment.create).toHaveBeenCalled();
      expect(notificationServiceMock.notify).toHaveBeenCalled();
    });
  });

  describe('6.3.5 - Reprogrammation d’un rendez-vous', () => {
    it('devrait reprogrammer un rendez-vous existant', async () => {
      const appointmentId = 100;
      const userId = 2;

      prismaMock.appointment.findUnique.mockResolvedValue({
        id: appointmentId,
        title: 'Réunion comptable',
        description: 'Discussion autour du dossier fiscal',
        type: 'consultation',
        date: new Date('2026-06-15T00:00:00.000Z'),
        hour: '10:00',
        meetingType: 'online',
        location: 'Google Meet',
        clientId: 1,
        accountantId: 2,
        companyId: 10,
        status: 'pending',
        clientNotes: 'Préparer les documents',
        guests: [],
      });

      prismaMock.appointment.create.mockResolvedValue({
        id: 101,
        title: 'Réunion comptable',
        description: 'Discussion autour du dossier fiscal',
        type: 'consultation',
        date: new Date('2026-06-20T00:00:00.000Z'),
        hour: '14:00',
        meetingType: 'online',
        location: 'Google Meet',
        clientId: 1,
        accountantId: 2,
        companyId: 10,
        status: 'pending',
        originalAppointmentId: appointmentId,
        clientNotes: 'Préparer les documents',
        accountantNotes: 'Changement de disponibilité',
        guests: [],
        client: { id: 1, firstName: 'Client', lastName: 'Test' },
        accountant: { id: 2, firstName: 'Comptable', lastName: 'Test' },
      });

      prismaMock.appointment.update.mockResolvedValue({
        id: appointmentId,
        status: 'rescheduled',
      });

      const result = await service.rescheduleAppointment(
        appointmentId,
        {
          date: '2026-06-20',
          hour: '14:00',
          reason: 'Changement de disponibilité',
        } as any,
        userId
      );

      expect(result.success).toBe(true);

      expect(prismaMock.appointment.findUnique).toHaveBeenCalledWith({
        where: { id: appointmentId },
      });

      expect(prismaMock.appointment.create).toHaveBeenCalled();

      expect(prismaMock.appointment.update).toHaveBeenCalledWith({
        where: { id: appointmentId },
        data: { status: 'rescheduled' },
      });

      expect(notificationServiceMock.notify).toHaveBeenCalled();
    });
  });
});

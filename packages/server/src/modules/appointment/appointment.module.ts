import { Module } from '@nestjs/common';
import { AppointmentController } from './appointment.controller';
import { AppointmentService } from './appointment.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { JwtService } from '@nestjs/jwt';
import { HashService } from 'src/common/crypto/hash.service';
import { JwtTokenService } from 'src/common/jwt/jwt-token.service';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { MinioService } from 'src/common/services/minio.service';
import { NotificationModule } from '../notification/notification.module';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [PrismaModule, NotificationModule],
  controllers: [AppointmentController],
  providers: [
    AppointmentService,
    AuthService,
    HashService,
    JwtTokenService,
    MailService,
    FileUploadService,
    JwtService,
    MinioService,
    ConfigService,
  ],
  exports: [AppointmentService],
})
export class AppointmentModule {}

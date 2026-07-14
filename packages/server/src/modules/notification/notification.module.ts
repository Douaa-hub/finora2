import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationController } from './notification.controller';
import { NotificationGateway } from './notification.gateway';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthService } from '../auth/auth.service';
import { HashService } from 'src/common/crypto/hash.service';
import { JwtTokenService } from 'src/common/jwt/jwt-token.service';
import { MailService } from '../mail/mail.service';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { MinioService } from 'src/common/services/minio.service';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
    }),
  ],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationGateway,
    AuthService,
    HashService,
    JwtTokenService,
    MailService,
    FileUploadService,
    MinioService,
  ],
  exports: [NotificationService, NotificationGateway],
})
export class NotificationModule {}

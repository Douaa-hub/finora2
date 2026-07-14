import { Module } from '@nestjs/common';
import { RequestController } from './request.controller';
import { RequestService } from './request.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { MinioService } from '../../common/services/minio.service';
import { JwtService } from '@nestjs/jwt';
import { HashService } from 'src/common/crypto/hash.service';
import { JwtTokenService } from 'src/common/jwt/jwt-token.service';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { NotificationModule } from '../notification/notification.module';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [PrismaModule, NotificationModule],
  controllers: [RequestController],
  providers: [
    RequestService,
    MinioService,
    AuthService,
    HashService,
    JwtTokenService,
    MailService,
    FileUploadService,
    JwtService,
    ConfigService,
  ],
  exports: [RequestService],
})
export class RequestModule {}

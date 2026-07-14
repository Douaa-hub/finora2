import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HashService } from '../crypto/hash.service';
import { PrismaService } from 'prisma/prisma.service';

@Injectable()
export class JwtTokenService {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private readonly hashService: HashService,
    private readonly prisma: PrismaService
  ) {}

  // Generate tokens
  public generateTokens(payload: {
    sub: number;
    email: string;
    roleCode?: string;
    companyId?: number | null;
  }) {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    const jwtRefreshSecret = this.configService.get<string>('JWT_REFRESH_SECRET');

    if (!jwtSecret) {
      throw new Error('JWT_SECRET is not configured. Please set it in your .env file.');
    }

    if (!jwtRefreshSecret) {
      throw new Error('JWT_REFRESH_SECRET is not configured. Please set it in your .env file.');
    }

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtSecret,
      expiresIn: '3h',
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: jwtRefreshSecret,
      expiresIn: '7d',
    });

    return { accessToken, refreshToken };
  }

  // Generate reset password token
  public generateResetToken(payload: { sub: number; email: string }) {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');

    if (!jwtSecret) {
      throw new Error('JWT_SECRET is not configured. Please set it in your .env file.');
    }

    return this.jwtService.sign(payload, {
      secret: jwtSecret,
      expiresIn: '3h',
    });
  }

  // Store refresh token in database
  public async storeRefreshToken(userId: number, refreshToken: string) {
    const hashedToken = this.hashService.hashToken(refreshToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.prisma.refreshToken.create({
      data: {
        token: hashedToken,
        userId,
        expiresAt,
      },
    });
  }

  // Delete refresh token
  public async deleteOldRefreshToken(tokenId: number): Promise<void> {
    await this.prisma.refreshToken.deleteMany({
      where: { id: tokenId },
    });
  }

  // Find valid refresh token for user
  public async findValidRefreshToken(userId: number) {
    return this.prisma.refreshToken.findFirst({
      where: {
        userId,
        isRevoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Clean up expired tokens
  public async cleanupExpiredTokens(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { isRevoked: true }],
      },
    });
    return result.count;
  }
}

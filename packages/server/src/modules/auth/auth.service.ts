import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { JwtTokenService } from 'src/common/jwt/jwt-token.service';
import { HashService } from 'src/common/crypto/hash.service';
import { ApiError } from 'src/common/errors/api-error';
import { errors } from 'src/common/errors/errors';
import * as jwt from 'jsonwebtoken';
import { MailService } from '../mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './types/jwt-payload.type';
import { AuthRequest } from './types/user-type';
import { RegisterClientDto } from './dto/register-client.dto';
import { RegisterAccountantDto } from './dto/register-accountant.dto';
import { FileUploadService, FileCategory } from 'src/common/services/file-upload.service';
import { MinioService } from 'src/common/services/minio.service';
import { RoleCode } from 'src/common/enums/role.enum';
import { UserStatus } from 'src/common/enums/user-status.enum';
import { MSG } from 'src/common/messages';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private hashService: HashService,
    private jwtTokenService: JwtTokenService,
    private mailService: MailService,
    private configService: ConfigService,
    private fileUploadService: FileUploadService,
    private minioService: MinioService
  ) {}

  // Login
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    console.log(loginDto, 'dto');
    try {
      const user = await this.prisma.user.findUnique({
        where: { email },
        include: {
          role: {
            include: {
              roleActions: {
                include: {
                  action: {
                    select: {
                      id: true,
                      name: true,
                      code: true,
                      category: true,
                      pageId: true,
                    },
                  },
                },
              },
              p_features: {
                include: {
                  feature: {
                    select: {
                      id: true,
                      slug: true,
                    },
                  },
                },
              },
              p_pages: {
                include: {
                  page: {
                    select: {
                      id: true,
                      slug: true,
                      PageUrl: true,
                      featureId: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      console.log('user', user);

      if (!user) {
        console.log('User not found');
        throw new ApiError(
          errors.BAD_CREDENTIEL.message,
          errors.BAD_CREDENTIEL.code,
          errors.BAD_CREDENTIEL.errorCode
        );
      }

      if (user.status !== UserStatus.ACTIVE) {
        console.log('User status is not active:', user.status);
        throw new ApiError(
          errors.BAD_CREDENTIEL.message,
          errors.BAD_CREDENTIEL.code,
          errors.BAD_CREDENTIEL.errorCode
        );
      }

      if (!user.role) {
        throw new ApiError(
          errors.NOT_FOUND.message,
          errors.NOT_FOUND.code,
          errors.NOT_FOUND.errorCode
        );
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      console.log('Password valid:', isPasswordValid);

      if (!isPasswordValid) {
        console.log('Password is invalid');
        throw new ApiError(
          errors.BAD_CREDENTIEL.message,
          errors.BAD_CREDENTIEL.code,
          errors.BAD_CREDENTIEL.errorCode
        );
      }

      const payload = {
        sub: user.id,
        email: user.email,
        roleCode: user.role?.code,
        companyId: user.companyId,
      };
      const { accessToken, refreshToken } = this.jwtTokenService.generateTokens(payload);

      await this.jwtTokenService.storeRefreshToken(user.id, refreshToken);

      // Build features structure with pages and actions (same as getCurrentUser)
      const featuresMap = new Map();
      const role = user.role;

      // First, create all features
      role.p_features.forEach((pf) => {
        if (!featuresMap.has(pf.feature.id)) {
          featuresMap.set(pf.feature.id, {
            id: String(pf.feature.id),
            name: pf.feature.slug,
            code: pf.feature.slug,
            pages: [],
          });
        }
      });

      // Then, add pages to their respective features
      role.p_pages.forEach((pp) => {
        const feature = featuresMap.get(pp.page.featureId);
        if (feature) {
          // Get actions for this page
          const pageActions = role.roleActions
            .filter((ra) => ra.action.pageId === pp.page.id)
            .map((ra) => ({
              id: String(ra.action.id),
              name: ra.action.name,
              code: ra.action.category?.toUpperCase() || 'READ',
            }));

          feature.pages.push({
            id: String(pp.page.id),
            name: pp.page.slug,
            code: pp.page.slug,
            route: pp.page.PageUrl,
            actions: pageActions,
          });
        }
      });

      const features = Array.from(featuresMap.values());

      return {
        success: true,
        data: {
          user: {
            id: String(user.id),
            email: user.email,
            full_name: user.username,
            sex: null,
            dateOfBirth: null,
            status: user.status,
            address: null,
            phone: user.phone || '',
            is_active: user.status === UserStatus.ACTIVE,
            is_email_verified: false,
            created_at: user.createdAt?.toISOString() || new Date().toISOString(),
            updated_at: user.updatedAt?.toISOString() || new Date().toISOString(),
            role: {
              id: String(role.id),
              name: role.nameEn,
              code: role.code || role.nameFr.toLowerCase().replace(/\s+/g, '_'),
              description: role.descriptionEn,
            },
            features,
          },
          accessToken,
          refreshToken,
        },
      };
    } catch (err) {
      console.error('Login error:', err);
      throw err;
    }
  }

  // Logout (revoke single token)
  async logout(refreshToken: string) {
    const hashedToken = this.hashService.hashToken(refreshToken);

    await this.prisma.refreshToken.updateMany({
      where: { token: hashedToken },
      data: { isRevoked: true },
    });

    return { success: true, message: MSG.auth.logout_success };
  }

  async refreshExpiredToken(expiredAccessToken: string) {
    try {
      const decoded = jwt.decode(expiredAccessToken);

      if (!decoded) {
        throw new ApiError(
          errors.INVALID_TOKEN.message,
          errors.INVALID_TOKEN.code,
          errors.INVALID_TOKEN.errorCode
        );
      }

      const { sub, email, roleCode, companyId } = decoded as unknown as JwtPayload;

      const storedRefreshToken = await this.jwtTokenService.findValidRefreshToken(sub);

      if (!storedRefreshToken) {
        console.log('No valid refresh token found for user:', sub);
        throw new ApiError(
          errors.INVALID_TOKEN.message,
          errors.INVALID_TOKEN.code,
          errors.INVALID_TOKEN.errorCode
        );
      }

      const { accessToken, refreshToken } = this.jwtTokenService.generateTokens({
        sub,
        email,
        roleCode,
        companyId,
      });

      await this.jwtTokenService.deleteOldRefreshToken(storedRefreshToken.id);

      await this.jwtTokenService.storeRefreshToken(sub, refreshToken);

      console.log('Tokens refreshed successfully for user:', sub);

      return {
        user: { sub, email },
        newTokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      };
    } catch (error) {
      console.error('Error refreshing token:', error);

      throw new ApiError(
        errors.INVALID_TOKEN.message,
        errors.INVALID_TOKEN.code,
        errors.INVALID_TOKEN.errorCode
      );
    }
  }

  async verifyAndRefreshToken(accessToken: string): Promise<{
    user: JwtPayload;
    newTokens?: { access_token: string; refresh_token: string };
  }> {
    const jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');

    try {
      const decoded = jwt.verify(accessToken, jwtSecret) as unknown as JwtPayload;
      return { user: decoded };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        //console.log('Access token expired, attempting to refresh...', error);
        return this.refreshExpiredToken(accessToken);
      }

      throw new ApiError(
        errors.INVALID_TOKEN.message,
        errors.INVALID_TOKEN.code,
        errors.INVALID_TOKEN.errorCode
      );
    }
  }

  async getCurrentUser(req: AuthRequest) {
    const loggedUserId = req?.user?.id;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: Number(loggedUserId) },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          phone: true,
          photo: true,
          coverPhoto: true,
          position: true,
          department: true,
          cin: true,
          diploma: true,
          companyId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          company: {
            select: {
              id: true,
              name: true,
              description: true,
              experience: true,
              logo: true,
              city: true,
              address: true,
              postalCode: true,
              phone: true,
              email: true,
            },
          },
          role: {
            select: {
              id: true,
              code: true,
              nameFr: true,
              nameEn: true,
              descriptionFr: true,
              descriptionEn: true,

              roleActions: {
                include: {
                  action: {
                    select: {
                      id: true,
                      name: true,
                      code: true,
                      category: true,
                      pageId: true,
                    },
                  },
                },
              },

              p_features: {
                include: {
                  feature: {
                    select: {
                      id: true,
                      slug: true,
                    },
                  },
                },
              },

              p_pages: {
                include: {
                  page: {
                    select: {
                      id: true,
                      slug: true,
                      PageUrl: true,
                      featureId: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!user) {
        throw new ApiError(
          errors.NOT_FOUND.message,
          errors.NOT_FOUND.code,
          errors.NOT_FOUND.errorCode
        );
      }

      if (!user.role) {
        throw new ApiError(
          errors.NOT_FOUND.message,
          errors.NOT_FOUND.code,
          errors.NOT_FOUND.errorCode
        );
      }

      if (user.status !== UserStatus.ACTIVE) {
        throw new ApiError(
          errors.BLOCKED_USER.message,
          errors.BLOCKED_USER.code,
          errors.BLOCKED_USER.errorCode
        );
      }

      // Build features structure with pages and actions
      const featuresMap = new Map();
      const role = user.role; // TypeScript assertion

      // First, create all features
      role.p_features.forEach((pf) => {
        if (!featuresMap.has(pf.feature.id)) {
          featuresMap.set(pf.feature.id, {
            id: String(pf.feature.id),
            name: pf.feature.slug,
            code: pf.feature.slug,
            pages: [],
          });
        }
      });

      // Then, add pages to their respective features
      role.p_pages.forEach((pp) => {
        const feature = featuresMap.get(pp.page.featureId);
        if (feature) {
          // Get actions for this page
          const pageActions = role.roleActions
            .filter((ra) => ra.action.pageId === pp.page.id)
            .map((ra) => ({
              id: String(ra.action.id),
              name: ra.action.name,
              code: ra.action.category?.toUpperCase() || 'READ',
            }));

          feature.pages.push({
            id: String(pp.page.id),
            name: pp.page.slug,
            code: pp.page.slug,
            route: pp.page.PageUrl,
            actions: pageActions,
          });
        }
      });

      const features = Array.from(featuresMap.values());

      // Generate presigned URLs for photo and coverPhoto if they exist
      let photoUrl: string | null = null;
      if (user.photo) {
        try {
          photoUrl = await this.minioService.getPresignedUrl(user.photo, 7 * 24 * 60 * 60); // 7 days
        } catch (error) {
          console.error('Error generating presigned URL for photo:', error);
          photoUrl = user.photo; // Fallback to path
        }
      }

      let coverPhotoUrl: string | null = null;
      if (user.coverPhoto) {
        try {
          coverPhotoUrl = await this.minioService.getPresignedUrl(
            user.coverPhoto,
            7 * 24 * 60 * 60
          ); // 7 days
        } catch (error) {
          console.error('Error generating presigned URL for cover photo:', error);
          coverPhotoUrl = user.coverPhoto; // Fallback to path
        }
      }

      // Generate presigned URL for company logo if exists
      let logoUrl: string | null = null;
      if (user.company?.logo) {
        try {
          logoUrl = await this.minioService.getPresignedUrl(user.company.logo, 7 * 24 * 60 * 60); // 7 days
        } catch (error) {
          console.error('Error generating presigned URL for company logo:', error);
          logoUrl = user.company.logo; // Fallback to path
        }
      }

      // Return structure matching frontend VerifyUserResponse
      return {
        id: String(user.id),
        email: user.email,
        full_name: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        photoUrl: photoUrl, // URL présignée MinIO
        coverPhotoUrl: coverPhotoUrl, // URL présignée MinIO
        position: user.position,
        department: user.department,
        cin: user.cin,
        diploma: user.diploma,
        sex: null,
        dateOfBirth: null,
        status: user.status,
        address: null,
        phone: user.phone || '',
        is_active: user.status === UserStatus.ACTIVE,
        created_at: user.createdAt.toISOString(),
        updated_at: user.updatedAt.toISOString(),
        company: user.company
          ? {
              id: user.company.id,
              name: user.company.name,
              description: user.company.description,
              experience: user.company.experience,
              logoUrl: logoUrl, // URL présignée MinIO
              city: user.company.city,
              address: user.company.address,
              postalCode: user.company.postalCode,
              phone: user.company.phone,
              email: user.company.email,
            }
          : null,
        role: {
          id: String(role.id),
          name: role.nameEn,
          code: role.code || role.nameFr.toLowerCase().replace(/\s+/g, '_'),
          description: role.descriptionEn,
        },
        features,
        token: '', // Token is in the Authorization header
      };
    } catch (err) {
      console.error('Get current user error:', err);
      throw err;
    }
  }

  // Get full user by ID
  async getFullUserById(userId: number) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          status: true,
          companyId: true,
          role: {
            select: {
              id: true,
              code: true,
              nameFr: true,
              nameEn: true,
            },
          },
        },
      });

      if (!user) {
        throw new ApiError(
          errors.NOT_FOUND.message,
          errors.NOT_FOUND.code,
          errors.NOT_FOUND.errorCode
        );
      }

      if (user.status !== UserStatus.ACTIVE) {
        throw new ApiError(
          errors.BLOCKED_USER.message,
          errors.BLOCKED_USER.code,
          errors.BLOCKED_USER.errorCode
        );
      }

      return user;
    } catch (err) {
      console.error('Login error:', err);
      throw err;
    }
  }

  // ForgotPassword
  async forgotPassword(email: string): Promise<{ success: boolean; message: string }> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        // Pour des raisons de sécurité, on retourne toujours un message de succès
        // même si l'email n'existe pas (évite l'énumération d'emails)
        return {
          success: true,
          message: MSG.user.reset_link_sent,
        };
      }

      // Générer le token de réinitialisation
      const resetToken = this.jwtTokenService.generateResetToken({
        sub: user.id,
        email: user.email,
      });

      const hashedToken = this.hashService.hashToken(resetToken);

      // Sauvegarder le token hashé et la date d'expiration (2 heures)
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          resetPasswordToken: hashedToken,
          resetPasswordExpires: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 heures
        },
      });

      // Construire le lien de réinitialisation
      const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
      const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

      // Envoyer l'email
      try {
        await this.mailService.sendPasswordResetEmail(user.email, resetLink);
        this.logger.log(`Password reset email sent to ${user.email}`);
      } catch (emailError) {
        this.logger.error(`Failed to send password reset email to ${user.email}:`, emailError);
        throw new ApiError(MSG.user.reset_email_failed, 500, 'EMAIL_SEND_FAILED');
      }

      return {
        success: true,
        message: MSG.user.reset_email_sent,
      };
    } catch (error) {
      this.logger.error('Forgot password error:', error);
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(
        'An error occurred while processing your request',
        500,
        'FORGOT_PASSWORD_ERROR'
      );
    }
  }

  // ResetPassword
  async resetPassword(
    token: string,
    password: string,
    confirmepassword: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Valider les mots de passe
      if (!password || password.trim() === '') {
        throw new ApiError(MSG.user.password_required, 400, 'PASSWORD_REQUIRED');
      }

      if (password.length < 8) {
        throw new ApiError(MSG.user.password_too_short, 400, 'PASSWORD_TOO_SHORT');
      }

      if (password !== confirmepassword) {
        throw new ApiError(MSG.user.passwords_mismatch, 400, 'PASSWORDS_DO_NOT_MATCH');
      }

      // Hasher le token pour le comparer avec celui en base
      const hashedToken = this.hashService.hashToken(token);

      // Trouver l'utilisateur avec un token valide et non expiré
      const user = await this.prisma.user.findFirst({
        where: {
          resetPasswordToken: hashedToken,
          resetPasswordExpires: {
            gt: new Date(), // Token non expiré
          },
        },
      });

      if (!user) {
        throw new ApiError(MSG.user.reset_link_invalid, 400, 'INVALID_OR_EXPIRED_TOKEN');
      }

      // Hasher le nouveau mot de passe
      const hashedPassword = await bcrypt.hash(password, 10);

      // Mettre à jour le mot de passe et supprimer le token
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          resetPasswordToken: null,
          resetPasswordExpires: null,
        },
      });

      this.logger.log(`Password successfully reset for user ${user.email}`);

      return {
        success: true,
        message: MSG.user.password_reset,
      };
    } catch (error) {
      this.logger.error('Reset password error:', error);
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(
        'Une erreur est survenue lors de la réinitialisation du mot de passe',
        500,
        'RESET_PASSWORD_ERROR'
      );
    }
  }

  // Register Client (external self-registration)
  async registerClient(dto: RegisterClientDto) {
    const { email, phone, password } = dto;

    try {
      // Check if email already exists
      const existingUser = await this.prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        throw new ApiError(MSG.user.already_exists, 400, 'EMAIL_EXISTS');
      }

      // Find CLIENT role by code
      const clientRole = await this.prisma.role.findUnique({
        where: { code: RoleCode.CLIENT },
      });

      if (!clientRole) {
        throw new ApiError(MSG.user.role_not_found, 500, 'ROLE_NOT_FOUND');
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Extract username from email
      const username = email.split('@')[0];

      // Create user with pending status
      const user = await this.prisma.user.create({
        data: {
          username,
          email,
          password: hashedPassword,
          phone,
          id_role: clientRole.id,
          status: UserStatus.ACTIVE,
        },
      });

      // Auto-create a company for the client (required for relationships, documents, etc.)
      const clientCompany = await this.prisma.company.create({
        data: {
          name: dto.companyName || username,
          email,
          phone,
          type: 'client',
          status: UserStatus.ACTIVE,
          ownerId: user.id,
        },
      });

      // Link user to company
      await this.prisma.user.update({
        where: { id: user.id },
        data: { companyId: clientCompany.id },
      });

      // Create default document folders for the client
      const defaultFolders = ['Vente', 'Achat', 'Banque', 'Devis'];
      try {
        for (const name of defaultFolders) {
          await this.prisma.document.create({
            data: {
              name,
              url: `documents/${clientCompany.id}/${name.toLowerCase()}`,
              type: 'folder',
              status: 'active',
              ownerId: user.id,
              companyId: clientCompany.id,
              isFolder: true,
              size: 0,
            },
          });
        }
      } catch (error) {
        console.error('Failed to create default folders for client:', error);
      }

      // Send welcome email with password
      try {
        await this.mailService.sendAccountCreatedWithPasswordEmail(
          email,
          username,
          password, // Send the plain password before hashing
          'Client',
          'Client'
        );
      } catch (error) {
        console.error('Failed to send welcome email:', error);
      }

      return {
        success: true,
        message: MSG.user.registered,
        data: {
          id: user.id,
          email: user.email,
          username: user.username,
          phone: user.phone,
          status: user.status,
        },
      };
    } catch (error) {
      console.error('Register client error:', error);
      throw error;
    }
  }

  // Register Accountant (external self-registration)
  async registerAccountant(
    dto: RegisterAccountantDto,
    files?: { patentFile?: Express.Multer.File[]; rneFile?: Express.Multer.File[] }
  ) {
    const { email, phone, firmName, password, specialties } = dto;

    try {
      // Check if email already exists
      const existingUser = await this.prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        throw new ApiError(MSG.user.already_exists, 400, 'EMAIL_EXISTS');
      }

      // Find ACCOUNTANT role by code
      const accountantRole = await this.prisma.role.findUnique({
        where: { code: RoleCode.ACCOUNTANT },
      });

      if (!accountantRole) {
        throw new ApiError(MSG.user.role_not_found, 500, 'ROLE_NOT_FOUND');
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Handle file uploads
      let patentFilePath: string | undefined;
      let rneFilePath: string | undefined;

      if (files?.patentFile && files.patentFile[0]) {
        patentFilePath = await this.fileUploadService.saveFile(
          files.patentFile[0],
          FileCategory.ACCOUNTANT_PATENT
        );
      }

      if (files?.rneFile && files.rneFile[0]) {
        rneFilePath = await this.fileUploadService.saveFile(
          files.rneFile[0],
          FileCategory.ACCOUNTANT_RNE
        );
      }

      // Convert specialties to array if it's a string
      let specialtiesArray: string[] = [];
      if (specialties) {
        if (Array.isArray(specialties)) {
          specialtiesArray = specialties;
        } else if (typeof specialties === 'string') {
          specialtiesArray = [specialties];
        }
      }

      // Create accounting firm with pending status
      const firm = await this.prisma.company.create({
        data: {
          name: firmName,
          patentFile: patentFilePath,
          rne: rneFilePath,
          phone,
          type: 'accounting_firm',
          status: UserStatus.PENDING,
          specialties: specialtiesArray,
        },
      });

      // Extract username from email
      const username = email.split('@')[0];

      // Create user with pending status
      const user = await this.prisma.user.create({
        data: {
          username,
          email,
          password: hashedPassword,
          phone,
          companyId: firm.id,
          id_role: accountantRole.id,
          status: UserStatus.PENDING,
        },
      });

      // Update company owner
      await this.prisma.company.update({
        where: { id: firm.id },
        data: { ownerId: user.id },
      });

      // Send welcome email with password
      try {
        await this.mailService.sendAccountCreatedWithPasswordEmail(
          email,
          username,
          password, // Send the plain password before hashing
          firmName,
          'Comptable'
        );
      } catch (error) {
        console.error('Failed to send welcome email:', error);
      }

      return {
        success: true,
        message: MSG.user.registered,
        data: {
          id: user.id,
          email: user.email,
          username: user.username,
          phone: user.phone,
          status: user.status,
          company: {
            id: firm.id,
            name: firm.name,
            patentFile: firm.patentFile,
            rne: firm.rne,
            specialties: firm.specialties,
          },
        },
      };
    } catch (error) {
      console.error('Register accountant error:', error);
      throw error;
    }
  }
}

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync } from 'fs';
import { setupSwagger } from './config/swagger';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { seedRoles } from '../prisma/seeds/role.seed';
import { seedFeatures } from '../prisma/seeds/features.seed';
import { seedPages } from '../prisma/seeds/pages.seed';
import { seedActions } from '../prisma/seeds/actions.seed';
import { seedUsers } from '../prisma/seeds/users.seed';
import { seedRolePermissions } from '../prisma/seeds/role-permissions.seed';

async function runSeeds() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    }),
  });

  try {
    // Check if data already exists - skip seeding if database has data
    const rolesCount = await prisma.role.count();
    const usersCount = await prisma.user.count();

    if (rolesCount > 0 || usersCount > 0) {
      console.log('✓ Database already seeded, skipping...');
      await prisma.$disconnect();
      return;
    }

    console.log('🌱 Running database seeds...');

    await seedRoles(prisma);
    await seedFeatures(prisma);
    await seedPages(prisma);
    await seedActions(prisma);
    await seedUsers(prisma);
    await seedRolePermissions(prisma);

    console.log('✓ Database seeding completed!');
  } catch (error) {
    console.error('❌ Error during seeding:', error);
  } finally {
    await prisma.$disconnect();
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: true, // Enable CORS at creation
  });

  // Fire OnModuleDestroy / OnApplicationShutdown on SIGINT/SIGTERM so the local
  // Whisper child process is terminated on every backend stop/restart.
  app.enableShutdownHooks();

  // Additional CORS configuration
  app.enableCors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
    allowedHeaders: '*',
  });

  // Helmet AFTER CORS and BEFORE other middleware
  app.use(
    helmet({
      contentSecurityPolicy: false, // Disable CSP for Swagger
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    })
  );

  app.setGlobalPrefix('api');

  app.use(rateLimit({ windowMs: 60000, max: 100 }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: false,
      forbidNonWhitelisted: false,
      transform: true,
      skipMissingProperties: true,
    })
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  // Add BigInt serializer interceptor
  app.useGlobalInterceptors(new BigIntSerializerInterceptor());

  // Setup Swagger documentation
  setupSwagger(app);

  // Fix path for both dev (src) and prod (dist)
  const uploadsPath = join(__dirname, '..', '..', 'uploads');
  if (!existsSync(uploadsPath)) {
    console.error('⚠️  Uploads folder not found at:', uploadsPath);
  } else {
    console.log('📁 Serving uploads from:', uploadsPath);
  }
  app.useStaticAssets(uploadsPath, {
    prefix: '/uploads/',
  });

  // Run seeds automatically on startup
  await runSeeds();

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  console.log(`\n🚀 Server is running on port ${port}`);
  console.log(`📚 Swagger UI:`);
  console.log(`   - http://localhost:${port}/docs`);
  console.log(`   - http://192.168.1.185:${port}/docs`);
  console.log(`🔌 API Base URL:`);
  console.log(`   - http://localhost:${port}/api`);
  console.log(`💬 WebSocket:`);
  console.log(`   - ws://localhost:${port}`);
  console.log(`   - ws://192.168.1.185:${port}`);
  console.log(`\n✅ All services ready!\n`);
}
bootstrap();

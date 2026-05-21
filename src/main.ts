// Load .env BEFORE any module imports so static config objects
// (AwarenessConfig, AnticipatoryConfig, etc.) see the real values.
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { HttpAdapterHost } from '@nestjs/core';
import * as bodyParser from 'body-parser';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { initSentry } from './common/sentry';
import { SentryExceptionFilter } from './common/sentry-exception.filter';
import { validateEncryptionKey } from './common/encryption.util';

// Initialize Sentry before anything else
initSentry();

// Validate encryption key is set (only required for cloud edition, skip in test)
if (process.env.NODE_ENV !== 'test' && process.env.EDITION === 'cloud') {
  validateEncryptionKey();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  // Increase body parser limit for cloud sync bulk pushes (default 100KB too small for batch payloads)
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

  // Trust Railway's reverse proxy so request.ip returns the real client IP
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', true);

  // Use Pino logger
  app.useLogger(app.get(Logger));

  // Sentry global exception filter
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new SentryExceptionFilter(httpAdapter));

  // Security headers (HSTS, X-Content-Type-Options, X-Frame-Options, hides X-Powered-By)
  // Relax CSP for the memory-graph static page (needs inline scripts/styles + d3 CDN)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'sha256-Arub96V7tDYxeyefl/tch5uyLEsB1uyQdjWYNnmy6u0='",
            'https://d3js.org',
          ],
          styleSrc: [
            "'self'",
            "'sha256-t5OiADah+ItveAkWwAGbQAHn9EHDXW7RJYCNvsSNi/Q='",
          ],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'https:', 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: [
            "'self'",
            'https://openengram.ai',
            'https://app.openengram.ai',
            'https://staging.openengram.ai',
            'https://*.vercel.app',
          ],
        },
      },
    }),
  );

  // Enable global validation pipe with transform
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false, // Allow legacy fields for backward compatibility
    }),
  );

  // CORS whitelist — configurable via CORS_ORIGINS env var (comma-separated)
  // Production origins are ALWAYS included regardless of env var
  const allowedOrigins = (() => {
    const origins = [
      'https://openengram.ai',
      'https://www.openengram.ai',
      'https://app.openengram.ai',
      'https://staging.openengram.ai',
    ];
    const envOrigins = process.env.CORS_ORIGINS;
    if (envOrigins) {
      envOrigins
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
        .forEach((o) => {
          if (!origins.includes(o)) origins.push(o);
        });
    }
    if (process.env.NODE_ENV !== 'production') {
      origins.push('http://localhost:3000');
      origins.push('http://localhost:3002');
      origins.push('http://10.0.0.108:3000');
      origins.push('http://10.0.0.108:3002');
    }
    return origins;
  })();

  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'X-AM-API-Key',
      'X-AM-User-ID',
      'x-api-key',
      'Authorization',
    ],
  });

  // Swagger / OpenAPI documentation
  const config = new DocumentBuilder()
    .setTitle('Engram API')
    .setDescription('Memory infrastructure for AI agents')
    .setVersion('2.0')
    .addBearerAuth()
    .addApiKey(
      { type: 'apiKey', name: 'X-AM-API-Key', in: 'header' },
      'api-key',
    )
    .addApiKey(
      { type: 'apiKey', name: 'X-AM-User-ID', in: 'header' },
      'user-id',
    )
    .addTag('memories', 'Core memory operations')
    .addTag('search', 'Semantic search and recall')
    .addTag('context', 'Context generation')
    .addTag('dedup', 'Deduplication management')
    .addTag('health', 'Health and monitoring')
    .addTag('webhooks', 'Webhook subscriptions')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();

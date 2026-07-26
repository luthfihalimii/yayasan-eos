import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: verifikasi HMAC DOKU butuh body mentah persis (digest), bukan hasil re-serialize JSON.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();

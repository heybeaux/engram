/**
 * Auth helpers for supertest requests.
 *
 * Returns the correct HTTP headers needed to authenticate as a given user/agent.
 */

import { JwtService } from '@nestjs/jwt';

export interface ApiKeyHeaders {
  [key: string]: string;
  'X-AM-API-Key': string;
  'X-AM-User-ID': string;
}

export interface JwtHeaders {
  Authorization: string;
}

/**
 * Returns supertest headers for API key authentication.
 *
 * @example
 * const headers = asUser(user.apiKey, user.userId);
 * await request(app.getHttpServer())
 *   .post('/v1/memories')
 *   .set(headers)
 *   .send({ raw: 'Hello' });
 */
export function asUser(apiKey: string, userId: string): ApiKeyHeaders {
  return {
    'X-AM-API-Key': apiKey,
    'X-AM-User-ID': userId,
  };
}

/**
 * Returns supertest Authorization header for JWT authentication.
 *
 * @example
 * const headers = asAccount(jwtService, accountId);
 * await request(app.getHttpServer())
 *   .get('/v1/account')
 *   .set(headers);
 */
export function asAccount(
  jwtService: JwtService,
  accountId: string,
): JwtHeaders {
  const token = jwtService.sign({ sub: accountId });
  return { Authorization: `Bearer ${token}` };
}

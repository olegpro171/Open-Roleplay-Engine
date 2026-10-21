import { message } from '../shared/localization.js';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, lt } from 'drizzle-orm';
import type { Store } from '../persistence/store.js';
import { owners, sessions } from '../persistence/schema.js';
import { AppError } from '../core/errors.js';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const sessionSeconds = 7 * 24 * 60 * 60;

export class Auth {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private store: Store) {}
  setupRequired() { return !this.store.db.select().from(owners).get(); }
  authenticated(token?: string) {
    if (!token) return false;
    const session = this.store.db.select().from(sessions).where(eq(sessions.hash, digest(token))).get();
    return Boolean(session && session.expiresAt > Date.now());
  }
  async setup(password: string) {
    if (!this.setupRequired()) throw new AppError(409, 'owner_exists', message("errors.an_owner_account_already_exists"));
    const salt = randomBytes(32).toString('hex');
    const hash = (await derive(password, salt, 64) as Buffer).toString('hex');
    if (!this.setupRequired()) throw new AppError(409, 'owner_exists', message("errors.an_owner_account_already_exists"));
    this.store.db.insert(owners).values({ id: 'owner', salt, hash }).run();
    return this.createSession();
  }
  async login(password: string, ip: string) {
    const attempt = this.attempts.get(ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= 5) throw new AppError(429, 'too_many_attempts', message("errors.too_many_attempts_try_again_in_15_minutes"));
    // Count before awaiting the password hash, including simultaneous attempts.
    this.attempts.set(ip, { count: attempt && attempt.until > Date.now() ? attempt.count + 1 : 1, until: attempt && attempt.until > Date.now() ? attempt.until : Date.now() + 900_000 });
    const owner = this.store.db.select().from(owners).get();
    if (!owner) throw new AppError(401, 'login_failed', message("errors.set_up_the_owner_account_on_the_server"));
    const hash = await derive(password, owner.salt, 64) as Buffer;
    if (!timingSafeEqual(hash, Buffer.from(owner.hash, 'hex'))) throw new AppError(401, 'login_failed', message("errors.incorrect_password"));
    this.attempts.delete(ip);
    return this.createSession();
  }
  private createSession() {
    const token = randomBytes(32).toString('base64url');
    this.store.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
    this.store.db.insert(sessions).values({ hash: digest(token), expiresAt: Date.now() + sessionSeconds * 1000 }).run();
    return token;
  }
  logout(token?: string) { if (token) this.store.db.delete(sessions).where(eq(sessions.hash, digest(token))).run(); }
}

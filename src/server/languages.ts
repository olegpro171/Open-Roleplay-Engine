import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { AppError } from '../core/errors.js';
import { englishPack, russianPack, languagePackSchema, languageLimits, languageFileProblem, message, validateTranslations, type LanguagePack, type LanguageStatus } from '../shared/localization.js';

type Loaded = { pack: LanguagePack; revision: string; custom: boolean; validation: ReturnType<typeof validateTranslations> };
function loaded(pack: LanguagePack, custom: boolean): Loaded {
  return { pack, custom, validation: validateTranslations(pack), revision: createHash('sha256').update(JSON.stringify(pack)).digest('hex') };
}
const bundled = new Map([['en', loaded(englishPack, false)], ['ru', loaded(russianPack, false)]]);
const builtins = () => new Map(bundled);
function missing(error: unknown) { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

/** Packs are presentation data, kept outside versioned application files and chat backups. */
export class Languages {
  private packs = builtins();
  private issues: LanguageStatus['issues'] = [];
  constructor(private directory: string) { this.reload(); }

  private directoryExists() {
    try {
      const stat = lstatSync(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a language directory');
      return true;
    } catch (error) { if (missing(error)) return false; throw error; }
  }

  reload(): LanguageStatus {
    const next = builtins();
    const issues: LanguageStatus['issues'] = [];
    try {
      if (!this.directoryExists()) { this.packs = next; this.issues = []; return this.status(); }
      const files = readdirSync(this.directory).filter(file => file.endsWith('.json')).sort();
      if (files.length > languageLimits.packs) throw new Error('Too many language files');
      let totalBytes = 0;
      for (const file of files) {
        try {
          // Canonical filenames prevent aliases, traversal and duplicate locale identities.
          const locale = file.slice(0, -5);
          if (!/^[a-zA-Z0-9-]+$/.test(locale) || locale === 'en') throw new Error('Invalid language filename');
          const path = join(this.directory, file);
          const entry = lstatSync(path);
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Expected a regular language file');
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let pack: LanguagePack;
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > languageLimits.bytes || (totalBytes += stat.size) > 20_000_000) throw new Error('Language size limit exceeded');
            pack = languagePackSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
          } finally { closeSync(fd); }
          if (pack.locale !== locale) throw new Error('Language filename does not match its locale');
          next.set(locale, loaded(pack, true));
        } catch (cause) {
          const previous = this.packs.get(file.slice(0, -5));
          if (previous?.custom) next.set(previous.pack.locale, previous);
          const problem = cause instanceof SyntaxError || cause instanceof ZodError ? languageFileProblem(cause) : message('language.issue');
          issues.push({ file: file.slice(0, 100), message: problem });
        }
      }
    } catch {
      this.issues = [{ file: 'languages', message: message('language.reloadFailed') }];
      return this.status();
    }
    this.packs = next;
    this.issues = issues;
    return this.status();
  }

  status(): LanguageStatus {
    return { languages: [...this.packs.values()].map(({ pack: { messages: _messages, ...metadata }, revision, custom, validation }) => ({
      ...metadata, revision, custom, total: Object.keys(englishPack.messages).length,
      translated: Object.keys(englishPack.messages).filter(key => Object.hasOwn(validation.messages, key)).length,
      translationIssues: validation.issues,
    })), issues: this.issues };
  }

  get(locale: string): LanguagePack {
    const item = this.packs.get(locale);
    if (!item) throw new AppError(404, 'language_not_found', message('language.fallback'));
    return item.pack;
  }

  save(value: unknown, expectedRevision: string | null): LanguageStatus {
    const parsed = languagePackSchema.safeParse(value);
    if (!parsed.success) throw new AppError(400, 'invalid_language', languageFileProblem(parsed.error));
    const pack = parsed.data;
    if (pack.locale === 'en') throw new AppError(400, 'reserved_language', message('language.englishReserved'));
    const bytes = JSON.stringify(pack, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > languageLimits.bytes) throw new AppError(413, 'language_limit', message('language.limit'));
    this.reload();
    if (this.issues.some(issue => issue.file === 'languages')) throw new AppError(500, 'languages_unavailable', message('language.reloadFailed'));
    const current = this.packs.get(pack.locale);
    if ((current?.custom ? current.revision : null) !== expectedRevision) throw new AppError(409, 'language_conflict', message('language.changed'));
    if (!current && this.packs.size >= languageLimits.packs) throw new AppError(413, 'language_limit', message('language.limit'));
    if (this.directoryExists()) {
      const otherBytes = readdirSync(this.directory).filter(file => file.endsWith('.json') && file !== `${pack.locale}.json`)
        .reduce((total, file) => total + lstatSync(join(this.directory, file)).size, 0);
      if (otherBytes + Buffer.byteLength(bytes) > 20_000_000) throw new AppError(413, 'language_limit', message('language.limit'));
    }
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      if (!this.directoryExists()) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, join(this.directory, `${pack.locale}.json`));
      } finally {
        try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
      }
    } catch (cause) {
      const failure = new AppError(500, 'language_save_failed', message('language.saveFailed'));
      failure.cause = cause;
      throw failure;
    }
    this.packs.set(pack.locale, loaded(pack, true));
    this.issues = this.issues.filter(issue => issue.file !== `${pack.locale}.json`);
    return this.status();
  }
}

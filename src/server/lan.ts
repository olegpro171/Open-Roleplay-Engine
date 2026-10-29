import { message, type LocalizedMessage } from '../shared/localization.js';
import type { IncomingMessage } from 'node:http';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { lanCommandSchema, lanInterfaceSchema, lanSettingsSchema, type LanInterface, type LanSettings, type LanStatus } from '../shared/lan.js';
import { allowedLanHost, allowedLanPeer, lanInterfaces, sameInterface } from './lan-policy.js';
import { localLanHostname, normalizeLocalHostname } from './lan-hostname.js';
import { listenLan, type LanRoute, type LanTransport, type ListenLan } from './lan-listener.js';

const savedSchema = z.object({
  version: z.literal(2), revision: z.number().int().nonnegative(), settings: lanSettingsSchema, binding: lanInterfaceSchema.nullable(),
}).strict();
const legacySchema = savedSchema.extend({ version: z.literal(1), settings: lanSettingsSchema.omit({ automatic: true }) });
type Saved = z.infer<typeof savedSchema>;
type Hostname = { state: 'available'; name: string } | { state: 'unavailable'; localized: LocalizedMessage };
type Listener = { transport: LanTransport; authority: symbol; binding: LanInterface; port: number; hostname: Hostname };
type Options = {
  interfaces?: () => LanInterface[];
  hostname?: () => Promise<string>;
  listen?: ListenLan;
  unavailable?: string;
};

// Machine-local intent stays outside portable chat backups. Automatic recovery
// changes live bindings, never saved revisions or in-progress editing drafts.
export class LanAccess {
  private saved: Saved = { version: 2, revision: 0, settings: { enabled: false, automatic: true, interfaceId: null, port: 3000 }, binding: null };
  private upgradePending = false;
  private listener: Listener | null = null;
  private message: string | LocalizedMessage | null = null;
  private invalidFile = false;
  private closed = false;
  private started = false;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private accepted = new WeakSet<IncomingMessage>();
  private closing = new Set<Promise<void>>();
  private work: Promise<void> = Promise.resolve();
  private refreshing: Promise<void> | null = null;
  private preferredInterface: string | null = null;
  private interfaces: () => LanInterface[];
  private hostname: () => Promise<string>;
  private listen: ListenLan;

  constructor(private file: string, private route: LanRoute, private options: Options = {}) {
    this.interfaces = options.interfaces ?? lanInterfaces;
    this.hostname = options.hostname ?? localLanHostname;
    this.listen = options.listen ?? listenLan;
    try {
      if (existsSync(file)) {
        const saved = z.union([savedSchema, legacySchema]).parse(JSON.parse(readFileSync(file, 'utf8')));
        if (saved.version === 1) {
          this.saved = { ...saved, version: 2, settings: { enabled: saved.settings.enabled, automatic: true, interfaceId: null, port: 3000 } };
          this.upgradePending = true;
        } else this.saved = saved;
        this.preferredInterface = this.saved.binding?.name ?? null;
      }
    } catch {
      this.invalidFile = true;
      this.message = message('lan_settings.saved_settings_unreadable');
    }
  }

  // Failed work rejects its caller while releasing the queue for recovery/Stop.
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.work.then(action);
    this.work = operation.then(() => {}, () => {});
    return operation;
  }

  start(): Promise<void> {
    return this.exclusive(async () => {
      if (this.started || this.closed) return;
      this.started = true;
      if (this.upgradePending) {
        try { this.write(this.saved); this.upgradePending = false; }
        catch (error) { this.invalidFile = true; this.message = this.failure(error); }
      }
      await this.reconcile();
      this.watch();
    });
  }

  isLanRequest(request: IncomingMessage) { return this.accepted.has(request); }

  status(canConfigure: boolean): LanStatus {
    this.checkNetwork();
    let runtime: LanStatus['runtime'];
    if (this.options.unavailable) {
      runtime = { state: 'unavailable', message: this.options.unavailable };
    } else if (this.message) {
      runtime = typeof this.message === 'string'
        ? { state: 'unavailable', message: this.message }
        : { state: 'unavailable', message: this.message.fallback, localized: this.message };
    } else if (this.listener) {
      const { binding, port, hostname } = this.listener;
      const ipv4Url = `http://${binding.address}:${port}`;
      const address = hostname.state === 'available'
        ? { state: 'available' as const, url: `http://${hostname.name}:${port}` }
        : hostname;
      runtime = { state: 'listening', ipv4Url, hostname: address, url: address.state === 'available' ? address.url : ipv4Url };
    } else {
      runtime = { state: 'off' };
    }
    return { revision: this.saved.revision, settings: { ...this.saved.settings }, interfaces: this.interfaces(), runtime, canConfigure: canConfigure && !this.options.unavailable };
  }

  save(value: unknown): Promise<LanStatus> {
    const { revision, ...input } = lanCommandSchema.parse(value);
    const settings: LanSettings = input.automatic ? { ...input, interfaceId: null, port: 3000 } : input;
    return this.exclusive(async () => {
      if (this.closed || !this.started || this.options.unavailable) throw new AppError(409, 'lan_unavailable', this.options.unavailable ?? 'LAN settings are unavailable while ORE is starting or stopping.');
      if (revision !== this.saved.revision) throw new AppError(409, 'lan_conflict', message("errors.lan_settings_changed_reload_lan_settings_before_saving"));
      this.checkNetwork();
      let prepared: Listener | null = null;
      try {
        const binding = settings.interfaceId ? this.interfaces().find(item => item.id === settings.interfaceId) ?? null : null;
        if (settings.enabled && !settings.automatic) {
          if (!binding) throw new AppError(409, 'lan_network_missing', message("errors.select_an_available_local_network_before_enabling_lan"));
          const active = this.listener;
          if (!active || !sameInterface(binding, active.binding) || active.port !== settings.port) prepared = await this.open(binding, settings.port);
          if (!this.current(binding)) throw new AppError(409, 'lan_network_changed', message("errors.the_local_network_changed_while_saving_reload_lan"));
        }
        if (this.closed) throw new AppError(409, 'lan_stopping', message("errors.ore_is_stopping_lan_settings_were_not_saved"));
        const next: Saved = { version: 2, revision: revision + 1, settings, binding };
        this.write(next);
        const previous = this.listener;
        this.saved = next;
        this.invalidFile = false;
        this.upgradePending = false;
        this.message = null;
        if (!settings.enabled) this.listener = null;
        else if (settings.automatic) this.listener = previous?.port === 3000 && this.current(previous.binding) ? previous : null;
        else this.listener = prepared ?? previous;
        prepared = null;
        if (previous && previous !== this.listener) await this.retire(previous);
        // Automatic intent commits even while offline/busy, so recovery needs no
        // later browser action. Manual saves retain prepare-before-commit safety.
        if (settings.enabled && settings.automatic) await this.reconcile();
        this.watch();
        return this.status(true);
      } catch (error) {
        if (prepared) await this.retire(prepared);
        if (error instanceof AppError) throw error;
        throw new AppError(503, 'lan_save_failed', this.failure(error));
      }
    });
  }

  /** The monitor and explicit refresh use the same serialized recovery path. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const operation = this.exclusive(async () => { await this.reconcile(); this.watch(); });
    this.refreshing = operation;
    void operation.then(() => { this.refreshing = null; }, () => { this.refreshing = null; });
    return operation;
  }

  private async reconcile() {
    if (this.closed || !this.started || this.invalidFile || this.options.unavailable || !this.saved.settings.enabled) return;
    const settings = this.saved.settings;
    try {
      this.checkNetwork();
      if (this.listener) return;
      const interfaces = [...this.interfaces()].sort((left, right) => left.id.localeCompare(right.id));
      const binding = settings.automatic
        ? interfaces.find(item => item.name === this.preferredInterface) ?? interfaces[0]
        : this.saved.binding;
      if (!binding || (!settings.automatic && binding.id !== settings.interfaceId) || !this.current(binding)) {
        throw new AppError(409, 'lan_network_unavailable', settings.automatic ? message("errors.no_local_network_is_available") : message("errors.the_saved_lan_address_or_subnet_is_unavailable"));
      }
      const prepared = await this.open(binding, settings.automatic ? 3000 : settings.port);
      if (this.closed || !this.current(binding)) {
        await this.retire(prepared);
        if (!this.closed) throw new AppError(409, 'lan_network_changed', message("errors.the_local_network_changed"));
        return;
      }
      this.listener = prepared;
      this.preferredInterface = binding.name;
      this.message = null;
    } catch (error) {
      this.message = this.failure(error) + (settings.automatic ? ' ORE will retry automatically.' : '');
    }
  }

  private current(binding: LanInterface) { return this.interfaces().some(item => sameInterface(item, binding)); }
  private checkNetwork() {
    if (this.listener && !this.current(this.listener.binding)) {
      const previous = this.listener;
      this.preferredInterface = previous.binding.name;
      this.listener = null;
      this.message = this.saved.settings.automatic ? 'The local network changed. ORE will reconnect automatically.'
        : message('lan_settings.manual_network_changed');
      void this.retire(previous);
    }
  }
  private watch() {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    if (!this.closed && !this.invalidFile && !this.options.unavailable && this.saved.settings.enabled && (this.saved.settings.automatic || this.listener)) {
      this.monitor = setInterval(() => { void this.refresh(); }, 3000);
      this.monitor.unref();
    }
  }
  private async open(binding: LanInterface, port: number): Promise<Listener> {
    let hostname: Hostname;
    try {
      const name = normalizeLocalHostname(await this.hostname());
      if (!name) throw new AppError(503, 'lan_hostname_invalid', message('errors.the_computer_needs_a_valid_local_hostname_before'));
      hostname = { state: 'available', name };
    } catch (error) {
      // Only discovery/validation failures are metadata failures. Programming
      // errors must still fail the operation instead of claiming successful LAN.
      if (!(error instanceof AppError) || !error.localized
        || (error.code !== 'lan_hostname_unavailable' && error.code !== 'lan_hostname_invalid')) throw error;
      hostname = { state: 'unavailable', localized: error.localized };
    }
    if (this.closed) throw new AppError(409, 'lan_stopping', message("errors.ore_is_stopping"));
    if (!this.current(binding)) throw new AppError(409, 'lan_network_changed', message('errors.the_local_network_changed'));
    const admittedHostname = hostname.state === 'available' ? hostname.name : null;
    const authority = Symbol('LAN listener');
    const transport = await this.listen(binding, port, (request, response) => {
      this.checkNetwork();
      if (this.closed || this.listener?.authority !== authority || !allowedLanPeer(request.socket.remoteAddress, binding)
        || request.socket.localAddress !== binding.address || !allowedLanHost(request.headers.host, binding, port, admittedHostname)) {
        response.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close' });
        response.end(JSON.stringify({ code: 'lan_access_denied', message: 'LAN access is unavailable for this address or network. Open ORE locally on the server computer.' }));
        return;
      }
      this.accepted.add(request);
      this.route(request, response);
    }, () => {
      if (this.listener?.authority !== authority) return;
      const previous = this.listener;
      this.listener = null;
      this.message = this.saved.settings.automatic ? 'The LAN listener failed. ORE will retry automatically.' : message('lan_settings.manual_listener_failed');
      void this.retire(previous);
    });
    return { transport, authority, binding, port, hostname };
  }
  private write(saved: Saved) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(saved) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, this.file);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
  private failure(error: unknown) {
    if (error instanceof AppError) return error.message;
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EADDRINUSE') return 'The LAN port is occupied.';
      if (error.code === 'EADDRNOTAVAIL') return 'The selected LAN address is unavailable.';
      if (error.code === 'EACCES' || error.code === 'EPERM') return 'Permission was denied while opening the LAN listener or saving settings.';
    }
    return 'LAN settings could not be applied. Check network availability, file permissions and free disk space.';
  }
  private retire(listener: Listener) {
    const closing = listener.transport.close();
    this.closing.add(closing);
    void closing.then(() => this.closing.delete(closing));
    return closing;
  }
  async close() {
    this.closed = true;
    if (this.monitor) clearInterval(this.monitor);
    const previous = this.listener;
    this.listener = null;
    if (previous) await this.retire(previous);
    await this.work;
    await Promise.all(this.closing);
  }
}

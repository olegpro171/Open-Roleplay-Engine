import { ApiError } from './api';

export type SettingsStatus<Settings> = { revision: number; settings: Settings };
export type AutosaveState<Settings, Status> = {
  status: Status | null;
  draft: Settings | null;
  saving: boolean;
  error: unknown;
};

/** Serializes field edits and rebases only those fields after a competing save. */
export class SettingsAutosave<Settings extends object, Status extends SettingsStatus<Settings>> {
  private status: Status | null;
  private queued: Partial<Settings> = {};
  private submitted: Partial<Settings> = {};
  private saving = false;
  private reconcile = false;
  private force = false;
  private submittedForce = false;
  private generation = 0;
  private reading = false;
  private error: unknown = null;
  private listeners = new Set<() => void>();
  private snapshot: AutosaveState<Settings, Status>;

  constructor(initial: Status | null, private readonly transport: {
    read: () => Promise<Status>;
    write: (status: SettingsStatus<Settings>) => Promise<Status>;
    committed: (status: Status) => void;
  }) {
    this.status = initial;
    this.snapshot = this.makeSnapshot();
  }

  private makeSnapshot(): AutosaveState<Settings, Status> {
    return {
      status: this.status,
      draft: this.status ? { ...this.status.settings, ...this.submitted, ...this.queued } : null,
      saving: this.saving,
      error: this.error,
    };
  }
  private publish() {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  observe(status: Status) {
    if (this.status && status.revision < this.status.revision) return;
    this.status = status;
    this.publish();
  }
  private accept(status: Status) {
    this.observe(status);
    this.transport.committed(status);
  }

  async refresh() {
    if (this.saving || this.reading) return;
    this.reading = true;
    const generation = this.generation;
    try {
      const status = await this.transport.read();
      if (generation !== this.generation) return;
      this.accept(status);
      // A background read must not clear a failed write or its retained edits.
      if (!Object.keys(this.queued).length) this.error = null;
    } catch (error) {
      if (generation === this.generation) this.error = error;
    } finally {
      this.reading = false;
      this.publish();
    }
  }

  update(patch: Partial<Settings>, force = false) {
    this.force ||= force;
    this.queued = { ...this.queued, ...patch };
    this.generation++;
    this.publish();
    void this.drain();
  }

  retry = async () => {
    if (this.saving) return;
    if (!Object.keys(this.queued).length) return this.refresh();
    this.reconcile = true;
    await this.drain();
  };

  private async drain() {
    if (this.saving || !this.status) return;
    this.generation++;
    this.saving = true;
    this.error = null;
    this.publish();
    try {
      while (Object.keys(this.queued).length) {
        this.submitted = this.queued;
        this.queued = {};
        this.submittedForce = this.force;
        this.force = false;
        let current = this.status;
        if (this.reconcile) {
          current = await this.transport.read();
          this.accept(current);
          this.reconcile = false;
        }
        let next: Status;
        const settings = { ...current.settings, ...this.submitted };
        const savedFields = new Map(Object.entries(current.settings));
        if (!this.submittedForce && Object.entries(this.submitted).every(([key, value]) => savedFields.get(key) === value)) {
          next = current;
        } else {
          try {
            next = await this.transport.write({ revision: current.revision, settings });
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409) throw error;
            const fresh = await this.transport.read();
            this.accept(fresh);
            // A non-revision conflict (such as an unavailable LAN network) needs user recovery.
            if (fresh.revision === current.revision) throw error;
            next = await this.transport.write({ revision: fresh.revision, settings: { ...fresh.settings, ...this.submitted } });
          }
        }
        this.submitted = {};
        this.submittedForce = false;
        this.accept(next);
      }
    } catch (error) {
      this.queued = { ...this.submitted, ...this.queued };
      this.force ||= this.submittedForce;
      this.submitted = {};
      this.submittedForce = false;
      this.reconcile = true;
      this.error = error;
    } finally {
      this.saving = false;
      this.publish();
    }
  }
}

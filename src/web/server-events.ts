import { eventHeartbeatMs } from '../shared/changes';

// A sleeping host can leave EventSource OPEN indefinitely. Replace a silent socket,
// including a replacement which never receives its HTTP response headers.
export function observeServerEvents(opened: () => void, disconnected: () => void, changed: (event: MessageEvent) => void) {
  let events: EventSource;
  let deadline: ReturnType<typeof setTimeout>;
  function armDeadline() {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      events.close();
      disconnected();
      connect();
    }, eventHeartbeatMs + 8_000);
  }
  function connect() {
    events = new EventSource('/api/events');
    events.onopen = () => { armDeadline(); opened(); };
    events.onmessage = event => { armDeadline(); changed(event); };
    events.addEventListener('heartbeat', armDeadline);
    events.onerror = disconnected;
    armDeadline();
  }
  connect();
  return () => {
    clearTimeout(deadline);
    events.close();
  };
}

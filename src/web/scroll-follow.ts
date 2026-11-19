function measureScroll(node: HTMLElement) {
  const end = Math.max(0, node.scrollHeight - node.clientHeight);
  return { top: Math.max(0, Math.min(node.scrollTop, end)), end };
}

export class ScrollFollow {
  following = true;
  private position = { top: 0, end: 0 };

  // Read before layout writes too. The browser can move the viewport before
  // delivering its scroll event, and a chunk may render in that gap.
  readMovement(node: HTMLElement) {
    const previous = this.position;
    const position = measureScroll(node);
    this.position = position;
    const previousTop = Math.min(previous.top, position.end);
    const atEnd = position.end - position.top <= 1; // Scroll dimensions are rounded.
    const clamped = position.end < previous.end && previous.top >= position.end && atEnd;
    if (position.top === previousTop || clamped) return false;
    if (position.top < previousTop) this.following = false;
    else if (atEnd) this.following = true;
    return true;
  }

  rememberPosition(node: HTMLElement) {
    this.position = measureScroll(node);
  }

  scrollToEnd(node: HTMLElement) {
    const height = node.scrollHeight;
    if (node.scrollTop < height - node.clientHeight) node.scrollTop = height;
    this.following = true;
    this.rememberPosition(node);
  }
}

/**
 * Merges and deduplicates added nodes across a batch of MutationRecords.
 * Discards non-element nodes and nested descendant elements whose ancestor
 * was already added in the same mutation batch, eliminating redundant subtree queries.
 */
export function deduplicateAddedNodes(records: MutationRecord[]): Element[] {
  const elements: Element[] = [];
  for (const record of records) {
    for (let i = 0; i < record.addedNodes.length; i++) {
      const node = record.addedNodes[i];
      if (node.nodeType === 1 /* Node.ELEMENT_NODE */) {
        elements.push(node as Element);
      }
    }
  }
  if (elements.length <= 1) return elements;

  return elements.filter((el) => {
    for (const other of elements) {
      if (other !== el && other.contains(el)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Two-stage MutationObserver that starts globally to locate the conversation
 * message container, and then migrates to observe ONLY that container.
 * If the container is destroyed or unmounted by React during navigation,
 * it safely falls back to global discovery until a new container appears.
 */
export class ScopedContainerObserver {
  private globalObserver: MutationObserver | null = null;
  private containerObserver: MutationObserver | null = null;
  private currentContainer: Element | null = null;
  private checkTimer?: number;

  constructor(
    private readonly pageWindow: Window & typeof globalThis,
    private readonly onMutations: (records: MutationRecord[]) => void,
    private readonly resolveContainer: () => Element | null,
    private readonly onContainerMigrated?: (container: Element | null) => void,
  ) {}

  get activeContainer(): Element | null {
    return this.currentContainer;
  }

  get isContainerScoped(): boolean {
    return this.currentContainer != null && this.containerObserver != null;
  }

  start(): void {
    const root = this.pageWindow.document.documentElement;
    if (!root) return;

    const initialContainer = this.resolveContainer();
    if (initialContainer) {
      this.attachToContainer(initialContainer);
    } else {
      this.attachGlobal(root);
    }

    if (this.checkTimer == null) {
      this.checkTimer = this.pageWindow.setInterval(() => {
        this.verifyContainer();
      }, 800);
    }
  }

  private attachGlobal(root: Element): void {
    if (this.containerObserver) {
      this.containerObserver.disconnect();
      this.containerObserver = null;
    }
    this.currentContainer = null;
    this.onContainerMigrated?.(null);

    if (this.globalObserver) return;

    this.globalObserver = new this.pageWindow.MutationObserver((records) => {
      const container = this.resolveContainer();
      if (container) {
        this.attachToContainer(container);
      }
      this.onMutations(records);
    });

    this.globalObserver.observe(root, { childList: true, subtree: true });
  }

  private attachToContainer(container: Element): void {
    if (this.globalObserver) {
      this.globalObserver.disconnect();
      this.globalObserver = null;
    }

    if (this.currentContainer === container && this.containerObserver) {
      return;
    }

    if (this.containerObserver) {
      this.containerObserver.disconnect();
    }

    this.currentContainer = container;
    this.onContainerMigrated?.(container);

    this.containerObserver = new this.pageWindow.MutationObserver((records) => {
      if (!this.currentContainer?.isConnected) {
        this.fallbackToGlobal();
        return;
      }
      this.onMutations(records);
    });

    this.containerObserver.observe(container, { childList: true, subtree: true });
  }

  private fallbackToGlobal(): void {
    const root = this.pageWindow.document.documentElement;
    if (root) {
      this.attachGlobal(root);
    }
  }

  private verifyContainer(): void {
    if (this.currentContainer && !this.currentContainer.isConnected) {
      this.fallbackToGlobal();
      return;
    }
    const freshContainer = this.resolveContainer();
    if (freshContainer && freshContainer !== this.currentContainer) {
      this.attachToContainer(freshContainer);
    }
  }

  disconnect(): void {
    if (this.checkTimer != null) {
      this.pageWindow.clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    this.globalObserver?.disconnect();
    this.globalObserver = null;
    this.containerObserver?.disconnect();
    this.containerObserver = null;
    this.currentContainer = null;
  }
}

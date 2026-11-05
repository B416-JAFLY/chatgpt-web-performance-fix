// Streamed message updates occur throughout the page; only changes to a
// sidebar, or insertion of a sidebar, can affect the refresh control.
export function sidebarMayHaveChanged(records: MutationRecord[]): boolean {
  for (const record of records) {
    const target = record.target;
    if (target.nodeType === 1 && (target as Element).closest("nav,aside")) return true;
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.matches("nav,aside") || element.querySelector("nav,aside")) return true;
    }
  }
  return false;
}

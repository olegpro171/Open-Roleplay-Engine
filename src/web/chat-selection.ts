import type { ChatSummary } from '../shared/library';

const branchSelectionPrefix = 'roleplay-branch:';

export function chatGroupId(branch: ChatSummary) {
  return branch.groupId ?? branch.id;
}

export function preferredBranch(branches: readonly ChatSummary[], rememberedId: string | undefined) {
  return branches.find(branch => branch.id === rememberedId) ?? branches[0];
}

export function readBranchSelections() {
  const selections = new Map<string, string>();
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(branchSelectionPrefix)) continue;
      const id = localStorage.getItem(key);
      if (id) selections.set(key.slice(branchSelectionPrefix.length), id);
    }
  } catch { /* Branch selection still works for this session. */ }
  return selections;
}

export function storeBranchSelection(groupId: string, id: string) {
  try { localStorage.setItem(branchSelectionPrefix + groupId, id); }
  catch { /* Keep the selection for this session. */ }
}

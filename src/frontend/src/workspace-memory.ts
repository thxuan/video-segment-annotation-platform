export type WorkspacePage = {
  view: "tasks" | "publish" | "stats" | "personal";
  selectedId: string | null;
};

export const workspacePageKey = (userId: string) =>
  `annotation-page-v1:${userId}`;
export const autoSaveKey = (userId: string) =>
  `annotation-autosave-v1:${userId}`;

export function readWorkspacePage(
  storage: Pick<Storage, "getItem">,
  userId: string,
  isAdmin: boolean,
): WorkspacePage {
  const fallback: WorkspacePage = { view: "tasks", selectedId: null };
  try {
    const value = JSON.parse(
      storage.getItem(workspacePageKey(userId)) ?? "null",
    );
    if (
      !value ||
      !["tasks", "publish", "stats", "personal"].includes(value.view) ||
      (!isAdmin && !["tasks", "personal"].includes(value.view)) ||
      (isAdmin && value.view === "personal")
    )
      return fallback;
    if (
      value.selectedId !== null &&
      (typeof value.selectedId !== "string" ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(value.selectedId))
    )
      return fallback;
    return {
      view: value.view,
      selectedId: ["publish", "personal"].includes(value.view)
        ? null
        : value.selectedId,
    };
  } catch {
    return fallback;
  }
}

export function readAutoSave(
  storage: Pick<Storage, "getItem">,
  userId: string,
): boolean {
  try {
    return storage.getItem(autoSaveKey(userId)) !== "false";
  } catch {
    return true;
  }
}

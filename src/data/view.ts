// 按标签页隔离工作台/门户视图偏好，避免多标签页不同角色互相干扰。
const KEY = "sdf.view";
export type ViewMode = "workbench" | "portal";
export const getViewMode = (): ViewMode => (typeof sessionStorage !== "undefined" && sessionStorage.getItem(KEY) === "portal" ? "portal" : "workbench");
export const setViewMode = (m: ViewMode) => {
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(KEY, m);
};

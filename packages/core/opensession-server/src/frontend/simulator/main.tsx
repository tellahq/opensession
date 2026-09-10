import { createRoot } from "react-dom/client";
import { SimulatorViewer } from "./SimulatorViewer";
import "../styles/base.css";

const theme = matchMedia("(prefers-color-scheme: light)");
function applyTheme() {
  document.documentElement.dataset.theme = theme.matches ? "light" : "dark";
  document.documentElement.style.colorScheme = theme.matches ? "light" : "dark";
}
applyTheme();
theme.addEventListener("change", applyTheme);
const root = document.getElementById("root");
if (root) createRoot(root).render(<SimulatorViewer />);

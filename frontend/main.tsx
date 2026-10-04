import { createRoot } from "react-dom/client";
import { GameApp } from "../components/GameApp";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(<GameApp />);

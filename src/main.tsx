import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DropTargetWindow } from "./components/DropTargetWindow";
import "./styles/app.css";

const isDropTarget =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("dropTarget") === "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isDropTarget ? <DropTargetWindow /> : <App />}
  </React.StrictMode>,
);

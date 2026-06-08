import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

async function bootstrap() {
  let tree = <App />;
  if (import.meta.env.DEV) {
    const { DevResponsivePreview } = await import("@/components/dev/DevResponsivePreview");
    tree = <DevResponsivePreview>{tree}</DevResponsivePreview>;
  }
  createRoot(document.getElementById("root")!).render(tree);
}

bootstrap();

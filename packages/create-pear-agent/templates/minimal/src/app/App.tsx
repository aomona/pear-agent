import { links, useRoute } from "./navigation";
import { ExecutePage } from "./pages/ExecutePage";
import { InputPage } from "./pages/InputPage";
import { PlanPage } from "./pages/PlanPage";
import { PlansPage } from "./pages/PlansPage";
import { pearConfig } from "../pear.config";

export function App() {
  const route = useRoute();

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href={links.plans()}>
          <span className="brand-mark">P</span>
          <span>{pearConfig.appName}</span>
        </a>
        <span className="eyebrow">Plan · Execute · Assess · Replan</span>
      </header>
      <main>
        {route.page === "plans" && <PlansPage />}
        {route.page === "input" && <InputPage planId={route.planId} />}
        {route.page === "plan" && <PlanPage planId={route.planId} />}
        {route.page === "execute" && <ExecutePage sessionId={route.sessionId} />}
      </main>
    </div>
  );
}

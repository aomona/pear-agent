import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PearProvider } from "@pear-agent/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { getPearContext, pearConfig } from "./pear.config";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PearProvider baseUrl={pearConfig.apiBaseUrl} getContext={getPearContext}>
        <App />
      </PearProvider>
    </QueryClientProvider>
  </StrictMode>,
);

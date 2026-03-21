import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "../Pages/LoginPage";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

// import { BASE_SERVER_URL } from "./constants/globals";
// location.href = `${BASE_SERVER_URL}/auth/google`;

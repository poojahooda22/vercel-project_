"use client";

import { BarChart3, FileText, LayoutGrid, LogOut, Moon, Rocket, Settings, Sun } from "lucide-react";
import { SidebarNav } from "@/components/SidebarNav/SidebarNav";
import type { SidebarNavItem } from "@/components/SidebarNav/SidebarNav";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/DropdownMenu/DropdownMenu";
import { signOut } from "@/lib/auth-client";

export const NAV_ITEMS: SidebarNavItem[] = [
  { id: "projects", label: "Projects", icon: <LayoutGrid className="size-[18px]" /> },
  { id: "deployments", label: "Deployments", icon: <Rocket className="size-[18px]" /> },
  { id: "logs", label: "Logs", icon: <FileText className="size-[18px]" /> },
  { id: "analytics", label: "Analytics", icon: <BarChart3 className="size-[18px]" /> },
];

function setTheme(theme: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Private-mode browsers reject localStorage; the theme still applies for this session.
  }
}

export function DashboardShell({
  children,
  active,
  onNavigate,
}: {
  children: React.ReactNode;
  active: string;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Fixed: the sidebar must not scroll away with the content. */}
      <div className="shrink-0 h-full">
        <SidebarNav
          style="simple"
          navItems={NAV_ITEMS}
          activeItemId={active}
          onNavItemClick={onNavigate}
          account={{
            name: "poojahooda22",
            email: "phooda938@gmail.com",
            menuItems: (
              <>
                <DropdownMenuItem onSelect={() => setTheme("light")}>
                  <Sun className="size-4" />
                  Light theme
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setTheme("dark")}>
                  <Moon className="size-4" />
                  Dark theme
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onNavigate("settings")}>
                  <Settings className="size-4" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    signOut().finally(() => {
                      window.location.href = "/login";
                    });
                  }}
                >
                  <LogOut className="size-4" />
                  Log out
                </DropdownMenuItem>
              </>
            ),
          }}
        />
      </div>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

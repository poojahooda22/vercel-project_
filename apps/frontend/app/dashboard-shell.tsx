"use client";

import { useState } from "react";
import {
  BarChart3,
  FileText,
  LayoutGrid,
  LogOut,
  Moon,
  PanelLeft,
  Rocket,
  Settings,
  Sun,
  Triangle,
} from "lucide-react";
import { SidebarNav } from "@/components/SidebarNav/SidebarNav";
import type { SidebarNavItem } from "@/components/SidebarNav/SidebarNav";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/DropdownMenu/DropdownMenu";
import { signOut, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

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

/** Header content: the wordmark, plus the control that collapses the rail.
 *  Collapsed leaves only the toggle, which the 64px header centres. */
function Brand({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <>
      {!collapsed && (
        <span className="flex min-w-0 items-center gap-md">
          <Triangle className="size-4 shrink-0 fill-foreground text-foreground" />
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">
            Deploy
          </span>
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-md",
          "text-foreground-tertiary transition-colors hover:bg-background-active hover:text-foreground",
          "focus-visible:outline-none focus-visible:shadow-focus-ring-brand-xs",
          !collapsed && "ml-auto",
        )}
      >
        <PanelLeft className="size-[18px]" />
      </button>
    </>
  );
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
  // Not persisted: reading localStorage during render would make the server's
  // expanded markup disagree with the client's on first paint.
  const [collapsed, setCollapsed] = useState(false);

  // The account row used to be two hardcoded strings, so it showed one particular
  // person no matter who was signed in. Better Auth already stores name, email and
  // the provider's avatar URL on the user row — this just reads them.
  const { data: session, isPending } = useSession();
  const user = session?.user;

  // Fall back to the email's local part: Better Auth allows a null name, and an
  // empty account row looks broken. While the session is still loading, show
  // nothing rather than a placeholder that would flash and then change.
  const displayName = user?.name || user?.email?.split("@")[0] || (isPending ? "…" : "Account");

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Fixed: the sidebar must not scroll away with the content. */}
      <div className="shrink-0 h-full">
        <SidebarNav
          // `slim` is the design system's icon-only rail — it already gives the
          // collapsed layout (64px, tooltips via title, centred account row).
          style={collapsed ? "slim" : "simple"}
          // cn() runs tailwind-merge, so a width here beats the component's own
          // w-[312px]. It MUST stay conditional: applied while collapsed it would
          // also override the slim rail's w-[64px] and break the collapse.
          className={cn(
            "transition-[width] duration-200 ease-out motion-reduce:transition-none",
            !collapsed && "w-64"
          )}
          logo={<Brand collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />}
          navItems={NAV_ITEMS}
          activeItemId={active}
          onNavItemClick={onNavigate}
          account={{
            name: displayName,
            email: user?.email ?? "",
            // The provider's profile photo. Google and GitHub both return one and
            // Better Auth persists it on the user row; the initials in the circle
            // are the fallback when it is missing or fails to load.
            avatarSrc: user?.image ?? undefined,
            menuItems: (
              <>
                <DropdownMenuItem icon={<Sun />} onSelect={() => setTheme("light")}>
                  Light theme
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Moon />} onSelect={() => setTheme("dark")}>
                  Dark theme
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem icon={<Settings />} onSelect={() => onNavigate("settings")}>
                  Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon={<LogOut />}
                  destructive
                  onSelect={() => {
                    signOut().finally(() => {
                      window.location.href = "/login";
                    });
                  }}
                >
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

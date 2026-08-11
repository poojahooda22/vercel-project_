import * as React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '../Badge/Badge';
import { AvatarDropdown } from '../DropdownMenu/AvatarDropdown';

export type SidebarNavStyle = 'simple' | 'dual-tier' | 'dual-tier-overlapped' | 'slim';

export interface SidebarNavItem {
    id: string;
    /** Pass with `className="size-[18px]"` for dense layout */
    icon?: React.ReactNode;
    label: string;
    active?: boolean;
    badge?: string;
    /** Rendered as accordion children in `simple` style */
    children?: SidebarNavItem[];
}

export interface SidebarNavGroup {
    heading?: string;
    items: SidebarNavItem[];
}

export interface SidebarNavAccount {
    name: string;
    email: string;
    avatarSrc?: string;
    /** Dropdown menu items rendered inside AvatarDropdown.
     *  Pass `<DropdownMenuItem>`, `<DropdownMenuSeparator>`, etc. */
    menuItems?: React.ReactNode;
    /** @deprecated Use `menuItems` instead. Kept for backward compatibility. */
    onLogout?: () => void;
}

export interface SidebarNavProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
    style?: SidebarNavStyle;
    /** Whether the secondary sub-nav panel is visible (dual-tier / slim only).
     *  @default false */
    open?: boolean;
    /** Logo element — pass `<CompanyProfile>` or `<CompanyLogo>`. */
    logo?: React.ReactNode;
    /** Grouped nav with optional section headings. Takes priority over `navItems`. */
    navGroups?: SidebarNavGroup[];
    navItems?: SidebarNavItem[];
    /** Pinned footer items (e.g. Help, Settings). */
    footerNavItems?: SidebarNavItem[];
    /** Secondary panel items shown when `open` is true. */
    subNavItems?: SidebarNavItem[];
    subNavTitle?: string;
    account?: SidebarNavAccount;
    onNavItemClick?: (id: string) => void;
    onSearchClick?: () => void;
    /** Falls back to `onNavItemClick` when not provided. */
    onSubNavItemClick?: (id: string) => void;
    /** When provided, renders a back button in the secondary panel. */
    onClose?: () => void;
    /**
     * When provided, the component marks the matching nav item as active internally.
     * Works with both `navItems` and `navGroups` (including nested children).
     * Eliminates the need to map over items and set `active: true` manually.
     */
    activeItemId?: string;
    /**
     * When provided, marks the matching sub-nav item as active (dual-tier / slim only).
     */
    activeSubItemId?: string;
}

interface NavItemRowProps {
    icon?: React.ReactNode;
    label: string;
    active?: boolean;
    badge?: string;
    /** Icon-only square button for slim style */
    iconOnly?: boolean;
    showChevron?: boolean;
    chevronOpen?: boolean;
    onClick?: () => void;
}

function NavItemRow({ icon, label, active, badge, iconOnly, showChevron, chevronOpen, onClick }: NavItemRowProps) {
    const base = 'transition-colors';
    const activeClass = 'bg-background-active text-foreground';
    const inactiveClass = 'text-foreground-tertiary hover:bg-background-active hover:text-foreground';

    if (iconOnly) {
        return (
            <button
                type="button"
                onClick={onClick}
                title={label}
                aria-current={active ? 'page' : undefined}
                className={cn(
                    base,
                    'flex items-center justify-center rounded-sm w-full h-10',
                    'focus-visible:outline-none focus-visible:shadow-focus-ring-brand-xs',
                    active ? activeClass : inactiveClass,
                )}
            >
                {icon}
            </button>
        );
    }

    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'page' : undefined}
            className={cn(
                base,
                'flex items-center gap-md px-md py-sm rounded-sm w-full text-left',
                'focus-visible:outline-none focus-visible:shadow-focus-ring-brand-xs',
                active ? activeClass : inactiveClass,
            )}
        >
            {icon && <span className="shrink-0">{icon}</span>}
            <span className="flex-1 text-sm font-medium truncate">{label}</span>
            {badge && (
                <Badge color="gray" size="sm" className="shrink-0">
                    {badge}
                </Badge>
            )}
            {showChevron && (
                <span className="shrink-0 text-fg-muted">
                    {chevronOpen
                        ? <ChevronUp className="size-4" />
                        : <ChevronDown className="size-4" />
                    }
                </span>
            )}
        </button>
    );
}

export const SidebarNav = React.forwardRef<HTMLDivElement, SidebarNavProps>(
    (
        {
            style = 'simple',
            open = false,
            logo,
            navGroups: navGroupsProp,
            navItems: navItemsProp = [],
            footerNavItems: footerNavItemsProp = [],
            subNavItems: subNavItemsProp = [],
            subNavTitle,
            account,
            onNavItemClick,
            onSubNavItemClick,
            onSearchClick,
            onClose,
            activeItemId,
            activeSubItemId,
            className,
            ...props
        },
        ref,
    ) => {
        /* When activeItemId / activeSubItemId is provided, derive active state internally */
        const markActive = React.useCallback(
            (item: SidebarNavItem, activeId?: string): SidebarNavItem => {
                const updated: SidebarNavItem = activeId
                    ? { ...item, active: item.id === activeId }
                    : item;
                if (updated.children?.length && activeId) {
                    return { ...updated, children: updated.children.map((c) => markActive(c, activeId)) };
                }
                return updated;
            },
            [],
        );

        const navGroups = React.useMemo(
            () => activeItemId && navGroupsProp
                ? navGroupsProp.map((g) => ({ ...g, items: g.items.map((item) => markActive(item, activeItemId)) }))
                : navGroupsProp,
            [navGroupsProp, activeItemId, markActive],
        );
        const navItems = React.useMemo(
            () => activeItemId ? navItemsProp.map((item) => markActive(item, activeItemId)) : navItemsProp,
            [navItemsProp, activeItemId, markActive],
        );
        const footerNavItems = React.useMemo(
            () => activeItemId ? footerNavItemsProp.map((item) => markActive(item, activeItemId)) : footerNavItemsProp,
            [footerNavItemsProp, activeItemId, markActive],
        );
        const subNavItems = React.useMemo(
            () => activeSubItemId ? subNavItemsProp.map((item) => ({ ...item, active: item.id === activeSubItemId })) : subNavItemsProp,
            [subNavItemsProp, activeSubItemId],
        );

        const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());

        const toggleExpand = (id: string) => {
            setExpandedIds((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
            });
        };

        const isSlim = style === 'slim';
        const isDualTier = style === 'dual-tier';
        const isDualTierOverlapped = style === 'dual-tier-overlapped';
        const isSimple = style === 'simple';
        const showSecondaryPanel = open && (isDualTier || isSlim);

        /* Overlapped variant: tier-2 swaps into the same column */
        const [overlappedTier, setOverlappedTier] = React.useState<'tier1' | 'tier2'>('tier1');
        const [overlappedLabel, setOverlappedLabel] = React.useState('');

        /* Reset to tier-1 when `open` is toggled off externally */
        React.useEffect(() => {
            if (isDualTierOverlapped && !open) {
                setOverlappedTier('tier1');
            }
        }, [isDualTierOverlapped, open]);

        const containerWidth = isSlim
            ? open ? 'w-[344px]' : 'w-[64px]'
            : isDualTier
                ? open ? 'w-[530px]' : 'w-[280px]'
                : isDualTierOverlapped
                    ? 'w-[280px]'
                    : 'w-[312px]';

        const primaryWidth = isSlim
            ? 'w-[64px] shrink-0'
            : isDualTier ? 'w-[280px] shrink-0'
                : 'flex-1 min-w-0';

        const renderItem = (item: SidebarNavItem, itemIndex: number) => {
            const hasChildren = isSimple && !!item.children?.length;
            const isExpanded = expandedIds.has(item.id);

            const staggerStyle = { animationDelay: `${itemIndex * 30}ms` };
            const staggerCss = 'animate-in fade-in-0 slide-in-from-left-1 duration-200 ease-out fill-mode-both motion-reduce:animate-none';

            /* Overlapped tier-1: show chevron-right and swap to tier-2 on click */
            if (isDualTierOverlapped && overlappedTier === 'tier1') {
                return (
                    <div key={item.id} className={cn('flex flex-col', staggerCss)} style={staggerStyle}>
                        <button
                            type="button"
                            aria-current={item.active ? 'page' : undefined}
                            onClick={() => {
                                onNavItemClick?.(item.id);
                                setOverlappedLabel(item.label);
                                setOverlappedTier('tier2');
                            }}
                            className={cn(
                                'flex items-center gap-md px-md py-sm rounded-sm w-full text-left transition-colors',
                                'focus-visible:outline-none focus-visible:shadow-focus-ring-brand-xs',
                                item.active
                                    ? 'bg-background-active text-foreground'
                                    : 'text-foreground-tertiary hover:bg-background-active hover:text-foreground',
                            )}
                        >
                            {item.icon && <span className="shrink-0">{item.icon}</span>}
                            <span className="flex-1 text-sm font-medium truncate">{item.label}</span>
                            {item.badge && (
                                <Badge color="gray" size="sm" className="shrink-0">
                                    {item.badge}
                                </Badge>
                            )}
                            <ChevronRight className="shrink-0 size-4 text-fg-muted" />
                        </button>
                    </div>
                );
            }

            return (
                <div key={item.id} className={cn('flex flex-col', staggerCss)} style={staggerStyle}>
                    <NavItemRow
                        icon={item.icon}
                        label={item.label}
                        active={item.active}
                        badge={item.badge}
                        iconOnly={isSlim}
                        showChevron={hasChildren}
                        chevronOpen={isExpanded}
                        onClick={() => {
                            if (hasChildren) toggleExpand(item.id);
                            else onNavItemClick?.(item.id);
                        }}
                    />
                    {hasChildren && isExpanded && (
                        <div className="flex flex-col gap-xxs pl-4xl pb-xs">
                            {item.children!.map((child) => (
                                <NavItemRow
                                    key={child.id}
                                    label={child.label}
                                    active={child.active}
                                    onClick={() => onNavItemClick?.(child.id)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            );
        };

        const GROUP_STAGGER_MS = 80;

        const primaryNavContent = navGroups?.length
            ? navGroups.map((group, groupIdx) => (
                <div
                    key={group.heading ?? groupIdx}
                    className="flex flex-col animate-in fade-in-0 slide-in-from-left-1 duration-250 ease-out fill-mode-both motion-reduce:animate-none"
                    style={{ animationDelay: `${groupIdx * GROUP_STAGGER_MS}ms` }}
                >
                    {group.heading && !isSlim && (
                        <p className="px-md pt-lg pb-xs text-xs font-medium uppercase tracking-[0.06em] text-foreground-tertiary select-none">
                            {group.heading}
                        </p>
                    )}
                    <div className="flex flex-col gap-xxs">
                        {group.items.map(renderItem)}
                    </div>
                </div>
            ))
            : <div className="flex flex-col gap-xxs">{navItems.map(renderItem)}</div>;

        return (
            <div
                ref={ref}
                className={cn(
                    'bg-background border-r border-secondary flex h-full',
                    containerWidth,
                    className,
                )}
                {...props}
            >
                {/* Primary column */}
                <div
                    className={cn(
                        'flex flex-col h-full',
                        primaryWidth,
                        showSecondaryPanel && 'border-r border-secondary',
                    )}
                >
                    {/* Logo + search */}
                    <div
                        className={cn(
                            'shrink-0 flex items-center h-[52px] border-b border-secondary',
                            isSlim ? 'px-md justify-center' : 'px-md',
                        )}
                    >
                        {logo}
                        {/* Only render search when a caller actually handles it —
                            otherwise the header ships a button that does nothing. */}
                        {!isSlim && onSearchClick && (
                            <button
                                type="button"
                                onClick={onSearchClick}
                                title="Search"
                                className="ml-auto shrink-0 p-sm rounded-md text-foreground-tertiary hover:bg-background-active hover:text-foreground transition-colors focus-visible:outline-none focus-visible:shadow-focus-ring-brand-xs"
                            >
                                <Search className="size-4" />
                            </button>
                        )}
                    </div>

                    {/* Scrollable nav groups — or overlapped tier-2 */}
                    <nav
                        className="flex-1 overflow-y-auto py-2xl px-md flex flex-col gap-xxs"
                        aria-label={isDualTierOverlapped && overlappedTier === 'tier2' ? 'Sub navigation' : 'Primary navigation'}
                    >
                        {isDualTierOverlapped && overlappedTier === 'tier2' ? (
                            <div className="flex flex-col gap-xxs">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setOverlappedTier('tier1');
                                        onClose?.();
                                    }}
                                    className={cn(
                                        'flex items-center gap-md px-md py-sm rounded-sm w-full text-left transition-colors mb-xs',
                                        'text-foreground-tertiary hover:bg-background-active hover:text-foreground',
                                        'focus-visible:outline-none focus-visible:shadow-focus-ring-brand-xs',
                                    )}
                                >
                                    <ChevronLeft className="shrink-0 size-4" />
                                    <span className="flex-1 text-sm font-semibold">{overlappedLabel || subNavTitle || 'Back'}</span>
                                </button>
                                {subNavItems.map((item, i) => (
                                    <div
                                        key={item.id}
                                        className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out fill-mode-both motion-reduce:animate-none"
                                        style={{ animationDelay: `${(i + 1) * 30}ms` }}
                                    >
                                        <NavItemRow
                                            icon={item.icon}
                                            label={item.label}
                                            active={item.active}
                                            badge={item.badge}
                                            onClick={() => {
                                                (onSubNavItemClick ?? onNavItemClick)?.(item.id);
                                                setOverlappedTier('tier1');
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : primaryNavContent}
                    </nav>

                    {/* Footer nav + account */}
                    <div className="shrink-0">
                        {footerNavItems.length > 0 && (
                            <nav
                                className={cn(
                                    'flex flex-col gap-xxs border-t border-secondary px-md py-2xl',
                                    isSlim && 'items-center px-md',
                                )}
                                aria-label="Footer navigation"
                            >
                                {footerNavItems.map((item) => (
                                    <NavItemRow
                                        key={item.id}
                                        icon={item.icon}
                                        label={item.label}
                                        active={item.active}
                                        iconOnly={isSlim}
                                        onClick={() => onNavItemClick?.(item.id)}
                                    />
                                ))}
                            </nav>
                        )}

                        {/* Account row — AvatarDropdown (non-slim) */}
                        {account && !isSlim && (
                            <div className="border-t border-secondary px-md py-2xl flex items-center">
                                <AvatarDropdown
                                    src={account.avatarSrc}
                                    fallback={account.name.slice(0, 2).toUpperCase()}
                                    name={account.name}
                                    email={account.email}
                                    side="top"
                                    align="start"
                                    sideOffset={8}
                                    showDetails
                                >
                                    {account.menuItems}
                                </AvatarDropdown>
                            </div>
                        )}

                        {/* Account row — AvatarDropdown (slim) */}
                        {account && isSlim && (
                            <div className="border-t border-secondary py-2xl flex items-center justify-center">
                                <AvatarDropdown
                                    src={account.avatarSrc}
                                    fallback={account.name.slice(0, 2).toUpperCase()}
                                    name={account.name}
                                    email={account.email}
                                    side="top"
                                    align="start"
                                    sideOffset={8}
                                >
                                    {account.menuItems}
                                </AvatarDropdown>
                            </div>
                        )}
                    </div>
                </div>

                {/* Secondary panel */}
                {showSecondaryPanel && (
                    <div className="flex flex-col h-full min-w-0 flex-1">

                        {isDualTier && (
                            <nav
                                className="flex flex-col gap-xxs pt-2xl px-md"
                                aria-label="Sub navigation"
                            >
                                {onClose && (
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="flex items-center gap-md px-md py-xs rounded-sm w-full text-left text-foreground-tertiary hover:bg-background-active hover:text-foreground transition-colors mb-xs focus-visible:outline-none focus-visible:shadow-focus-ring-brand-xs"
                                    >
                                        <ChevronLeft className="shrink-0 size-4" />
                                        <span className="flex-1 text-sm font-semibold">
                                            {subNavTitle ?? 'Back'}
                                        </span>
                                    </button>
                                )}
                                {subNavItems.map((item, i) => (
                                    <div
                                        key={item.id}
                                        className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out fill-mode-both motion-reduce:animate-none"
                                        style={{ animationDelay: `${(i + 1) * 30}ms` }}
                                    >
                                        <NavItemRow
                                            icon={item.icon}
                                            label={item.label}
                                            active={item.active}
                                            badge={item.badge}
                                            onClick={() => (onSubNavItemClick ?? onNavItemClick)?.(item.id)}
                                        />
                                    </div>
                                ))}
                            </nav>
                        )}

                        {isSlim && (
                            <div className="flex-1 flex flex-col gap-2xl pt-xl px-md">
                                {onClose ? (
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="flex items-center gap-md px-md py-xs rounded-sm w-full text-left text-foreground-tertiary hover:bg-background-active hover:text-foreground transition-colors focus-visible:outline-none focus-visible:shadow-focus-ring-brand-xs"
                                    >
                                        <ChevronLeft className="shrink-0 size-4" />
                                        <span className="flex-1 text-sm font-semibold">
                                            {subNavTitle ?? 'Back'}
                                        </span>
                                    </button>
                                ) : subNavTitle ? (
                                    <p className="text-sm font-semibold text-foreground px-md">
                                        {subNavTitle}
                                    </p>
                                ) : null}
                                <nav className="flex flex-col gap-xxs" aria-label="Sub navigation">
                                    {subNavItems.map((item, i) => (
                                        <div
                                            key={item.id}
                                            className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out fill-mode-both motion-reduce:animate-none"
                                            style={{ animationDelay: `${(i + 1) * 30}ms` }}
                                        >
                                            <NavItemRow
                                                icon={item.icon}
                                                label={item.label}
                                                active={item.active}
                                                badge={item.badge}
                                                onClick={() => (onSubNavItemClick ?? onNavItemClick)?.(item.id)}
                                            />
                                        </div>
                                    ))}
                                </nav>
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    },
);

SidebarNav.displayName = 'SidebarNav';

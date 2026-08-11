import * as React from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarImage, AvatarFallback, AvatarStatus } from '../Avatar/Avatar';
import { AvatarLabelGroup } from '../Avatar/AvatarLabelGroup';
import type { AvatarStatusType } from '../Avatar/Avatar';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
} from './DropdownMenu';

export interface AvatarDropdownProps {
    src?: string;
    /** Two-letter fallback initials. */
    fallback?: string;
    name: string;
    /** Secondary text in header (email, role, etc.). */
    email?: string;
    status?: AvatarStatusType;
    /** Render the trigger as a full-width row (avatar + name + chevron) instead of
     *  a bare avatar. Used by the sidebar footer, where the name has room to show. */
    showDetails?: boolean;
    children: React.ReactNode;
    /** @default 'end' */
    align?: 'start' | 'center' | 'end';
    /** @default 'bottom' */
    side?: 'top' | 'right' | 'bottom' | 'left';
    /** @default 4 */
    sideOffset?: number;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
    className?: string;
    contentClassName?: string;
}

export const AvatarDropdown = React.forwardRef<HTMLButtonElement, AvatarDropdownProps>(
    ({
        src,
        fallback,
        name,
        email,
        status,
        showDetails = false,
        children,
        align = 'end',
        side = 'bottom',
        sideOffset = 4,
        open: controlledOpen,
        onOpenChange,
        disabled,
        className,
        contentClassName,
    }, ref) => {
        const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
        const isControlled = controlledOpen !== undefined;
        const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

        const handleOpenChange = (nextOpen: boolean) => {
            if (!isControlled) setUncontrolledOpen(nextOpen);
            onOpenChange?.(nextOpen);
        };

        return (
            <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
                <DropdownMenuTrigger asChild disabled={disabled}>
                    <button
                        ref={ref}
                        type="button"
                        className={cn(
                            'focus-visible:outline-none cursor-pointer',
                            'focus-visible:shadow-focus-ring-brand',
                            'disabled:opacity-50 disabled:pointer-events-none',
                            showDetails
                                ? 'flex w-full items-center gap-md rounded-md p-sm text-left transition-colors hover:bg-background-active'
                                : 'rounded-full',
                            isOpen && (showDetails ? 'bg-background-active' : 'shadow-focus-ring-gray'),
                            className
                        )}
                        aria-label={`Open user menu for ${name}`}
                    >
                        <Avatar size={showDetails ? 'sm' : 'md'}>
                            <AvatarImage src={src} alt={name} />
                            <AvatarFallback>{fallback}</AvatarFallback>
                            {status && <AvatarStatus status={status} />}
                        </Avatar>
                        {showDetails && (
                            <>
                                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                    {name}
                                </span>
                                <ChevronsUpDown className="size-4 shrink-0 text-foreground-tertiary" />
                            </>
                        )}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    open={isOpen}
                    align={align}
                    side={side}
                    sideOffset={sideOffset}
                    className={cn('p-0', contentClassName)}
                >
                    {/* User header */}
                    <div className="px-2xl py-xl border-b border-secondary">
                        <AvatarLabelGroup
                            src={src}
                            fallback={fallback}
                            name={name}
                            email={email}
                            status={status}
                            size="md"
                        />
                    </div>
                    {/* Menu items */}
                    <div className="pt-xs">
                        {children}
                    </div>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    },
);

AvatarDropdown.displayName = 'AvatarDropdown';

import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

const DropdownMenu = DropdownMenuPrimitive.Root;
DropdownMenu.displayName = 'DropdownMenu';

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

const DropdownMenuGroup = DropdownMenuPrimitive.Group;
DropdownMenuGroup.displayName = 'DropdownMenuGroup';

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
DropdownMenuPortal.displayName = 'DropdownMenuPortal';

/* ── Motion variants ───────────────────────────────────────────────── */

const containerVariants = {
    closed: { height: 0, opacity: 0 },
    open: { height: 'auto' as const, opacity: 1 },
};

const containerTransition = {
    height: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const },
    opacity: { duration: 0.2, ease: 'easeOut' as const },
};

const staggerParentVariants = {
    closed: {},
    open: { transition: { staggerChildren: 0.03, delayChildren: 0.06 } },
};

const itemVariants = {
    closed: { opacity: 0, y: -4 },
    open: { opacity: 1, y: 0 },
};

const itemTransition = { duration: 0.15, ease: 'easeOut' as const };

/* ── DropdownMenuContent ───────────────────────────────────────────── */

interface DropdownMenuContentProps
    extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> {
    /** Pass the open state from the parent to drive enter/exit animations. */
    open?: boolean;
}

const DropdownMenuContent = React.forwardRef<
    React.ElementRef<typeof DropdownMenuPrimitive.Content>,
    DropdownMenuContentProps
>(({ className, sideOffset = 4, children, open, ...props }, ref) => {
    const shouldReduceMotion = useReducedMotion();

    // React's DOM drag/animation handlers and Motion's same-named props have
    // incompatible signatures, so spreading Radix's props straight into
    // motion.div does not typecheck. This dropdown uses none of them; dropping
    // them from the motion spread keeps behaviour identical.
    const {
        onDrag: _onDrag,
        onDragStart: _onDragStart,
        onDragEnd: _onDragEnd,
        onAnimationStart: _onAnimationStart,
        onAnimationEnd: _onAnimationEnd,
        onAnimationIteration: _onAnimationIteration,
        ...motionProps
    } = props;

    const staggered = React.Children.map(children, (child, i) =>
        React.isValidElement(child) ? (
            <motion.div key={i} variants={itemVariants} transition={itemTransition}>
                {child}
            </motion.div>
        ) : child,
    );

    /* When `open` is not provided, fall back to Radix default (no FM animation) */
    if (open === undefined) {
        return (
            <DropdownMenuPrimitive.Portal>
                <DropdownMenuPrimitive.Content
                    ref={ref}
                    sideOffset={sideOffset}
                    className={cn(
                        'z-50 w-[240px] flex flex-col overflow-x-hidden overflow-y-auto scrollbar-themed',
                        'max-h-[var(--radix-dropdown-menu-content-available-height)]',
                        'bg-background border border-secondary rounded-md',
                        'shadow-lg',
                        'py-sm',
                        'data-[state=open]:animate-dropdown-grow',
                        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-75',
                        'origin-[--radix-dropdown-menu-content-transform-origin]',
                        className,
                    )}
                    {...props}
                >
                    {children}
                </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
        );
    }

    /* Framer Motion height-reveal path */
    return (
        <DropdownMenuPrimitive.Portal forceMount>
            <AnimatePresence>
                {open && (
                    <DropdownMenuPrimitive.Content
                        ref={ref}
                        sideOffset={sideOffset}
                        forceMount
                        asChild
                    >
                        <motion.div
                            className={cn(
                                'z-50 w-[240px] flex flex-col',
                                'max-h-[var(--radix-dropdown-menu-content-available-height)]',
                                'bg-background border border-secondary rounded-md',
                                'shadow-lg',
                                className,
                            )}
                            initial={shouldReduceMotion ? false : undefined}
                            animate="open"
                            exit="open"
                            {...motionProps}
                        >
                            {/* Inner container — clips content during height animation */}
                            <motion.div
                                className="overflow-hidden rounded-md"
                                variants={shouldReduceMotion ? undefined : containerVariants}
                                initial="closed"
                                animate="open"
                                exit="closed"
                                transition={containerTransition}
                            >
                                <div className="py-sm overflow-x-hidden overflow-y-auto scrollbar-themed">
                                    <motion.div
                                        variants={shouldReduceMotion ? undefined : staggerParentVariants}
                                        initial="closed"
                                        animate="open"
                                    >
                                        {staggered}
                                    </motion.div>
                                </div>
                            </motion.div>
                        </motion.div>
                    </DropdownMenuPrimitive.Content>
                )}
            </AnimatePresence>
        </DropdownMenuPrimitive.Portal>
    );
});
DropdownMenuContent.displayName = 'DropdownMenuContent';

/* ── DropdownMenuItem ──────────────────────────────────────────────── */

export interface DropdownMenuItemProps
    extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
    /** Leading icon (renders at 18px, stroke 1.6). */
    icon?: React.ReactNode;
    /** Right-aligned shortcut hint. */
    meta?: React.ReactNode;
    destructive?: boolean;
}

const DropdownMenuItem = React.forwardRef<
    React.ElementRef<typeof DropdownMenuPrimitive.Item>,
    DropdownMenuItemProps
>(({ className, icon, meta, destructive = false, children, ...props }, ref) => (
    <DropdownMenuPrimitive.Item
        ref={ref}
        className={cn(
            'flex items-center gap-md mx-sm rounded-sm px-lg py-sm',
            'text-sm font-medium',
            'text-foreground-secondary',
            'cursor-default select-none focus-visible:outline-none',
            'data-[highlighted]:bg-background-secondary-hover data-[highlighted]:text-foreground',
            'data-[disabled]:opacity-50 data-[disabled]:pointer-events-none',
            destructive && 'text-foreground-error data-[highlighted]:text-foreground-error',
            className
        )}
        {...props}
    >
        {icon && (
            <span className="shrink-0 [&_svg]:size-[18px] [&_svg]:stroke-[1.6]" aria-hidden="true">
                {icon}
            </span>
        )}
        <span className="flex-1 truncate">{children}</span>
        {meta && (
            <span className="shrink-0">{meta}</span>
        )}
    </DropdownMenuPrimitive.Item>
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

/* ── Other primitives ──────────────────────────────────────────────── */

const DropdownMenuSeparator = React.forwardRef<
    React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
    React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
    <DropdownMenuPrimitive.Separator
        ref={ref}
        className={cn('h-px bg-border-secondary my-xs', className)}
        {...props}
    />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

const DropdownMenuLabel = React.forwardRef<
    React.ElementRef<typeof DropdownMenuPrimitive.Label>,
    React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
    <DropdownMenuPrimitive.Label
        ref={ref}
        className={cn(
            'mx-sm px-lg pt-sm pb-xs',
            'text-xs font-semibold uppercase tracking-wide',
            'text-foreground-tertiary',
            className
        )}
        {...props}
    />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

export {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuLabel,
    DropdownMenuGroup,
    DropdownMenuPortal,
};
export type { DropdownMenuContentProps };

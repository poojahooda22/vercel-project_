import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ModalIconBadgeStatus = 'success' | 'warning' | 'error' | 'default';

const Modal = DialogPrimitive.Root;

const ModalTrigger = DialogPrimitive.Trigger;

const ModalClose = DialogPrimitive.Close;

const ModalOverlay = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Overlay>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay
        ref={ref}
        className={cn(
            'fixed inset-0 z-50 bg-black/30 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            className
        )}
        {...props}
    />
));
ModalOverlay.displayName = 'ModalOverlay';

export interface ModalContentProps
    extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
    /** @default false */
    showClose?: boolean;
}

const ModalContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    ModalContentProps
>(({ className, children, showClose = false, ...props }, ref) => (
    <DialogPrimitive.Portal>
        <ModalOverlay />
        <DialogPrimitive.Content
            ref={ref}
            className={cn(
                'fixed left-1/2 top-1/2 z-50',
                '-translate-x-1/2 -translate-y-1/2',
                'w-full max-w-[400px]',
                'flex flex-col',
                'bg-background rounded-xl shadow-xl overflow-hidden',
                'data-[state=open]:animate-modal-overshoot',
                'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-150',
                'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
                'focus-visible:outline-none',
                className
            )}
            {...props}
        >
            {children}
            {showClose && (
                <DialogPrimitive.Close
                    className={cn(
                        'absolute right-2xl top-2xl',
                        'rounded-sm p-xs',
                        'text-fg-muted hover:text-fg-secondary',
                        'outline-none focus-visible:shadow-focus-ring-brand focus-visible:rounded-sm',
                        'transition-colors cursor-pointer'
                    )}
                >
                    <X className="size-5" />
                    <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
            )}
        </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
));
ModalContent.displayName = 'ModalContent';

export interface ModalHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

const ModalHeader = React.forwardRef<HTMLDivElement, ModalHeaderProps>(
    ({ className, ...props }, ref) => (
        <div
            ref={ref}
            className={cn('flex flex-col gap-2xl p-2xl', className)}
            {...props}
        />
    )
);
ModalHeader.displayName = 'ModalHeader';

const statusBgClasses: Record<ModalIconBadgeStatus, string> = {
    success: 'bg-background-success',
    warning: 'bg-background-warning',
    error: 'bg-background-error',
    default: 'bg-background-tertiary',
};

const statusIconClasses: Record<ModalIconBadgeStatus, string> = {
    success: 'text-fg-success',
    warning: 'text-fg-warning',
    error: 'text-fg-error',
    default: 'text-fg-muted',
};

export interface ModalIconBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
    /** @default 'default' */
    status?: ModalIconBadgeStatus;
}

const ModalIconBadge = React.forwardRef<HTMLDivElement, ModalIconBadgeProps>(
    ({ status = 'default', className, children, ...props }, ref) => (
        <div
            ref={ref}
            className={cn(
                'flex items-center justify-center size-8xl rounded-full shrink-0',
                statusBgClasses[status],
                className
            )}
            {...props}
        >
            <span className={cn('[&_svg]:size-6 [&_svg]:stroke-[1.6]', statusIconClasses[status])}>
                {children}
            </span>
        </div>
    )
);
ModalIconBadge.displayName = 'ModalIconBadge';

export interface ModalTitleProps
    extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> {}

const ModalTitle = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Title>,
    ModalTitleProps
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn('text-lg font-semibold text-foreground', className)}
        {...props}
    />
));
ModalTitle.displayName = 'ModalTitle';

export interface ModalDescriptionProps
    extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> {}

const ModalDescription = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Description>,
    ModalDescriptionProps
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn('text-sm text-foreground-tertiary', className)}
        {...props}
    />
));
ModalDescription.displayName = 'ModalDescription';

export interface ModalBodyProps extends React.HTMLAttributes<HTMLDivElement> {}

const ModalBody = React.forwardRef<HTMLDivElement, ModalBodyProps>(
    ({ className, ...props }, ref) => (
        <div
            ref={ref}
            className={cn('flex-1 min-h-0 overflow-y-auto scrollbar-themed px-2xl', className)}
            {...props}
        />
    )
);
ModalBody.displayName = 'ModalBody';

export interface ModalFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

const ModalFooter = React.forwardRef<HTMLDivElement, ModalFooterProps>(
    ({ className, ...props }, ref) => (
        <div
            ref={ref}
            className={cn('flex gap-xl p-2xl', className)}
            {...props}
        />
    )
);
ModalFooter.displayName = 'ModalFooter';

export {
    Modal,
    ModalTrigger,
    ModalClose,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalIconBadge,
    ModalTitle,
    ModalDescription,
    ModalBody,
    ModalFooter,
};

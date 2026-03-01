import React from 'react';
import { cn } from '../lib/utils';

export interface PixelButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'default' | 'active' | 'green';
    size?: 'sm' | 'md' | 'lg';
}

export const PixelButton = React.forwardRef<HTMLButtonElement, PixelButtonProps>(
    ({ className, variant = 'default', size = 'md', ...props }, ref) => {
        return (
            <button
                ref={ref}
                className={cn(
                    'relative inline-flex items-center justify-center uppercase transition-all duration-75 select-none',
                    'active:translate-y-[2px]',
                    // Size variants
                    {
                        'px-2 py-1 text-[8px]': size === 'sm',
                        'px-4 py-2 text-[10px]': size === 'md',
                        'px-6 py-3 text-[12px]': size === 'lg',
                    },
                    // Color/Style variants defined by custom box shadow borders
                    {
                        'bg-mchs-gray text-white pixel-borders hover:brightness-110': variant === 'default',
                        'bg-mchs-gray text-mchs-green pixel-borders-active': variant === 'active',
                        'bg-mchs-green text-white pixel-borders hover:bg-mchs-green-hover': variant === 'green',
                    },
                    className
                )}
                {...props}
            />
        );
    }
);
PixelButton.displayName = 'PixelButton';

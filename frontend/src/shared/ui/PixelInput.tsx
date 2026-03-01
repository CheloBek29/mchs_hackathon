import React from 'react';
import { cn } from '../lib/utils';

export type PixelInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const PixelInput = React.forwardRef<HTMLInputElement, PixelInputProps>(
    ({ className, type = 'text', ...props }, ref) => {
        return (
            <input
                type={type}
                ref={ref}
                className={cn(
                    'bg-[#404040] text-white border-2 border-black outline-none',
                    'px-2 py-1 text-[10px] w-full',
                    'placeholder:text-gray-500',
                    'focus:border-gray-500 transition-colors',
                    className
                )}
                {...props}
            />
        );
    }
);
PixelInput.displayName = 'PixelInput';

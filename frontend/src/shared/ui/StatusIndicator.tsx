import React from 'react';
import { cn } from '../lib/utils';

export type IndicatorColor = 'red' | 'orange' | 'blue' | 'gray' | 'green' | 'line';

export interface StatusIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
    color?: IndicatorColor;
    size?: number; // width and height in px, or length for line
}

export const StatusIndicator = React.forwardRef<HTMLDivElement, StatusIndicatorProps>(
    ({ className, color = 'red', size = 8, ...props }, ref) => {
        // Special render for "line" variant (рукав)
        if (color === 'line') {
            return (
                <div
                    ref={ref}
                    style={{ width: size * 3, height: 2 }} // A bit wider and very thin
                    className={cn('bg-white', className)}
                    {...props}
                />
            );
        }

        return (
            <div
                ref={ref}
                style={{ width: size, height: size }}
                className={cn(
                    'rounded-full', // The mockup shows small circles for these indicators
                    {
                        'bg-[#e74c3c]': color === 'red',
                        'bg-[#f39c12]': color === 'orange',
                        'bg-[#3498db]': color === 'blue',
                        'bg-gray-500': color === 'gray',
                        'bg-[#2ecc71]': color === 'green',
                    },
                    className
                )}
                {...props}
            />
        );
    }
);
StatusIndicator.displayName = 'StatusIndicator';

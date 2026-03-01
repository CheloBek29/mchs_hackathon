import React, { useState, useEffect } from 'react';

export const PixelClock: React.FC = () => {
    const [time, setTime] = useState(new Date());

    useEffect(() => {
        // Usually for a simulator, you might get this from a Zustand store handling simulation time,
        // but for the visual purposes of this MVP, we'll use a simple local interval.
        const interval = setInterval(() => {
            setTime(new Date());
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    // Format to HH:MM (e.g. 13:30)
    const formattedTime = time.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
    });

    return (
        <div className="text-white text-[24px] font-pixel drop-shadow-[2px_2px_0_rgba(0,0,0,0.8)] tracking-widest">
            {formattedTime}
        </div>
    );
};

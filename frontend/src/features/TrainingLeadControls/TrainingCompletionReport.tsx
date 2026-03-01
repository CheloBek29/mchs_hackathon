import React, { useMemo } from 'react';
import type { SessionStateBundleDto } from '../../shared/api/types';
import { PixelButton } from '../../shared/ui/PixelButton';
import { parseDispatcherJournal } from '../DispatcherControls/DispatcherSidebar';
import { SimulationBoard } from '../../widgets/SimulationBoard/SimulationBoard';

type TrainingCompletionReportProps = {
    bundle: SessionStateBundleDto | null;
    onClose?: () => void;
};

export const TrainingCompletionReport: React.FC<TrainingCompletionReportProps> = ({ bundle, onClose }) => {
    const journalEntries = useMemo(() => {
        return parseDispatcherJournal(bundle?.snapshot?.snapshot_data);
    }, [bundle?.snapshot?.snapshot_data]);

    return (
        <div className="flex flex-col h-full bg-[#111] overflow-hidden text-gray-200 p-4">
            <div className="flex items-center justify-between mb-4 border-b-2 border-gray-700 pb-2 flex-shrink-0">
                <h2 className="text-sm text-green-400 font-bold uppercase tracking-wider">
                    ОТЧЕТ О ЗАВЕРШЕНИИ ТРЕНИРОВКИ
                </h2>
                {onClose && (
                    <PixelButton size="sm" variant="default" onClick={onClose}>
                        ЗАКРЫТЬ
                    </PixelButton>
                )}
            </div>

            <div className="flex-1 flex flex-col min-h-0 gap-4">
                {/* UPPER HALF: Journal */}
                <div className="flex-1 flex flex-col min-h-0 border-2 border-gray-800 bg-[#161616] rounded-sm p-3">
                    <h3 className="text-xs text-blue-300 uppercase mb-2">Журнал диспетчера</h3>
                    <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                        {journalEntries.length === 0 ? (
                            <div className="text-[10px] text-gray-500 italic py-4 text-center">Журнал пуст</div>
                        ) : (
                            journalEntries.map((entry: any) => (
                                <div key={entry.id} className="text-[9px] border-b border-gray-800 pb-2">
                                    <div className="flex justify-between text-gray-400 mb-1">
                                        <span>{new Date(entry.created_at).toLocaleTimeString('ru-RU')}</span>
                                        <span>{entry.author}</span>
                                    </div>
                                    <div className="text-gray-200">{entry.text}</div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* LOWER HALF: Schemas */}
                <div className="flex-1 min-h-0 grid grid-cols-3 gap-4">
                    <div className="flex flex-col h-full border-2 border-gray-800 bg-[#161616] rounded-sm p-2">
                        <h3 className="text-[10px] text-blue-300 uppercase mb-2 text-center">Схема: ШТАБ</h3>
                        <div className="flex-1 border border-black overflow-hidden relative">
                            <SimulationBoard activeRole="ШТАБ" isReadOnly />
                        </div>
                    </div>
                    <div className="flex flex-col h-full border-2 border-gray-800 bg-[#161616] rounded-sm p-2">
                        <h3 className="text-[10px] text-blue-300 uppercase mb-2 text-center">Схема: БУ-1</h3>
                        <div className="flex-1 border border-black overflow-hidden relative">
                            <SimulationBoard activeRole="БУ - 1" isReadOnly />
                        </div>
                    </div>
                    <div className="flex flex-col h-full border-2 border-gray-800 bg-[#161616] rounded-sm p-2">
                        <h3 className="text-[10px] text-blue-300 uppercase mb-2 text-center">Схема: БУ-2</h3>
                        <div className="flex-1 border border-black overflow-hidden relative">
                            <SimulationBoard activeRole="БУ - 2" isReadOnly />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

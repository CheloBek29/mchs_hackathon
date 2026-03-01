import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../shared/api/client';
import type { LessonLlmEvaluationDto, SessionStateBundleDto } from '../../shared/api/types';
import { PixelButton } from '../../shared/ui/PixelButton';
import { parseDispatcherJournal } from '../DispatcherControls/DispatcherSidebar';
import { SimulationBoard } from '../../widgets/SimulationBoard/SimulationBoard';

type TrainingCompletionReportProps = {
  bundle: SessionStateBundleDto | null;
  onClose?: () => void;
};

type JournalEntry = ReturnType<typeof parseDispatcherJournal>[number];

const toTextList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
    .slice(0, 8);
};

const toUserActionRows = (value: unknown): Array<{ who: string; notes: string }> => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const row = item as Record<string, unknown>;
      const username = typeof row.username === 'string' ? row.username.trim() : '';
      const role = typeof row.role === 'string' ? row.role.trim() : '';
      const actions = typeof row.actions === 'string' ? row.actions.trim() : '';
      const comment = typeof row.comment === 'string' ? row.comment.trim() : '';
      const notes = [actions, comment].filter((chunk) => chunk.length > 0).join(' | ');
      const who = [username, role].filter((chunk) => chunk.length > 0).join(' / ');
      if (!notes) {
        return null;
      }
      return {
        who: who || 'Участник',
        notes,
      };
    })
    .filter((row): row is { who: string; notes: string } => row !== null)
    .slice(0, 12);
};

export const TrainingCompletionReport: React.FC<TrainingCompletionReportProps> = ({ bundle, onClose }) => {
  const [evaluation, setEvaluation] = useState<LessonLlmEvaluationDto | null>(null);
  const [isLoadingEvaluation, setIsLoadingEvaluation] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluationError, setEvaluationError] = useState('');

  const journalEntries = useMemo<JournalEntry[]>(() => {
    return parseDispatcherJournal(bundle?.snapshot?.snapshot_data as Record<string, unknown> | null | undefined);
  }, [bundle?.snapshot?.snapshot_data]);

  useEffect(() => {
    const sessionId = bundle?.session.id;
    if (!sessionId) {
      setEvaluation(null);
      setEvaluationError('');
      return;
    }

    let cancelled = false;
    setIsLoadingEvaluation(true);
    setEvaluationError('');
    void apiClient
      .get<LessonLlmEvaluationDto | null>(`/lessons/evaluate?session_id=${encodeURIComponent(sessionId)}`)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setEvaluation(response);
      })
      .catch(() => {
        if (!cancelled) {
          setEvaluation(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingEvaluation(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bundle?.session.id]);

  const evaluationJson = useMemo(() => {
    if (!evaluation?.result_json || typeof evaluation.result_json !== 'object') {
      return null;
    }
    return evaluation.result_json as Record<string, unknown>;
  }, [evaluation?.result_json]);

  const summaryText = useMemo(() => {
    if (evaluationJson && typeof evaluationJson.summary === 'string' && evaluationJson.summary.trim().length > 0) {
      return evaluationJson.summary.trim();
    }
    if (typeof evaluation?.result_text === 'string' && evaluation.result_text.trim().length > 0) {
      return evaluation.result_text.trim();
    }
    return '';
  }, [evaluation?.result_text, evaluationJson]);

  const criticalIssues = useMemo(() => {
    if (!evaluationJson) {
      return [];
    }
    return toTextList(evaluationJson.critical_issues);
  }, [evaluationJson]);

  const recommendations = useMemo(() => {
    if (!evaluationJson) {
      return [];
    }
    return toTextList(evaluationJson.recommendations);
  }, [evaluationJson]);

  const actionsByUser = useMemo(() => {
    if (!evaluationJson) {
      return [];
    }
    return toUserActionRows(evaluationJson.actions_by_user);
  }, [evaluationJson]);

  const handleRunEvaluation = async () => {
    const sessionId = bundle?.session.id;
    if (!sessionId) {
      setEvaluationError('Сессия не выбрана');
      return;
    }
    setEvaluationError('');
    setIsEvaluating(true);
    try {
      const payload: Record<string, unknown> = {
        session_id: sessionId,
        max_radio_transmissions: 80,
        max_journal_entries: 120,
      };
      const response = await apiClient.post<LessonLlmEvaluationDto>('/lessons/evaluate', payload);
      setEvaluation(response);
    } catch (error) {
      setEvaluationError(error instanceof Error ? error.message : 'Не удалось оценить урок через LLM');
    } finally {
      setIsEvaluating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#111] overflow-hidden text-gray-200 p-4">
      <div className="flex items-center justify-between mb-4 border-b-2 border-gray-700 pb-2 flex-shrink-0">
        <h2 className="text-sm text-green-400 font-bold uppercase tracking-wider">
          ОТЧЕТ О ЗАВЕРШЕНИИ ТРЕНИРОВКИ
        </h2>
        <div className="flex items-center gap-2">
          <PixelButton
            size="sm"
            variant="green"
            disabled={isEvaluating || !bundle?.session.id}
            onClick={() => {
              void handleRunEvaluation();
            }}
          >
            {isEvaluating ? 'ОЦЕНКА...' : 'ОЦЕНИТЬ LLM'}
          </PixelButton>
          {onClose ? (
            <PixelButton size="sm" variant="default" onClick={onClose}>
              ЗАКРЫТЬ
            </PixelButton>
          ) : null}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0 gap-4">
        <div className="border-2 border-gray-800 bg-[#161616] rounded-sm p-3">
          <h3 className="text-xs text-blue-300 uppercase mb-2">LLM-разбор урока</h3>
          {isLoadingEvaluation ? <div className="text-[9px] text-gray-400">Загрузка сохраненной оценки...</div> : null}
          {!isLoadingEvaluation && !evaluation ? (
            <div className="text-[9px] text-gray-500">Оценка еще не рассчитана. Нажми «ОЦЕНИТЬ LLM».</div>
          ) : null}

          {evaluation ? (
            <div className="space-y-2 text-[9px] normal-case">
              <div className="text-gray-300">
                Модель: <span className="text-green-300">{evaluation.model}</span> | Время:{' '}
                <span className="text-gray-200">{new Date(evaluation.generated_at).toLocaleString('ru-RU')}</span>
              </div>
              {summaryText ? <div className="text-gray-100">{summaryText}</div> : null}

              {actionsByUser.length > 0 ? (
                <div>
                  <div className="text-gray-400 mb-1">Кто что делал:</div>
                  <div className="space-y-1">
                    {actionsByUser.map((row, index) => (
                      <div key={`${row.who}-${index}`} className="text-gray-200">
                        - {row.who}: {row.notes}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {criticalIssues.length > 0 ? (
                <div>
                  <div className="text-red-300 mb-1">Критичные проблемы:</div>
                  {criticalIssues.map((issue, index) => (
                    <div key={`${issue}-${index}`} className="text-red-200">
                      - {issue}
                    </div>
                  ))}
                </div>
              ) : null}

              {recommendations.length > 0 ? (
                <div>
                  <div className="text-cyan-300 mb-1">Рекомендации:</div>
                  {recommendations.map((item, index) => (
                    <div key={`${item}-${index}`} className="text-cyan-200">
                      - {item}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {evaluationError ? <div className="text-[9px] text-red-300 mt-2">{evaluationError}</div> : null}
        </div>

        <div className="flex-1 flex flex-col min-h-0 border-2 border-gray-800 bg-[#161616] rounded-sm p-3">
          <h3 className="text-xs text-blue-300 uppercase mb-2">Журнал диспетчера</h3>
          <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
            {journalEntries.length === 0 ? (
              <div className="text-[10px] text-gray-500 italic py-4 text-center">Журнал пуст</div>
            ) : (
              journalEntries.map((entry) => (
                <div key={entry.id} className="text-[9px] border-b border-gray-800 pb-2">
                  <div className="flex justify-between text-gray-400 mb-1">
                    <span>{new Date(entry.created_at).toLocaleTimeString('ru-RU')}</span>
                    <span>{entry.author ?? 'СИСТЕМА'}</span>
                  </div>
                  <div className="text-gray-200">{entry.text}</div>
                </div>
              ))
            )}
          </div>
        </div>

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

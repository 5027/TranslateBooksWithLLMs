/**
 * Translation Tracker - Track active translations and handle WebSocket updates
 *
 * Manages active translation state, WebSocket event handling,
 * translation completion, error handling, and batch queue progression.
 */

import { StateManager } from '../core/state-manager.js';
import { ApiClient } from '../core/api-client.js';
import { MessageLogger } from '../ui/message-logger.js';
import { DomHelpers } from '../ui/dom-helpers.js';
import { StatusManager } from '../utils/status-manager.js';
import { FileUpload } from '../files/file-upload.js';
import { FileActions } from '../files/file-actions.js';
import { ProgressManager, formatElapsedTime, deriveRateContext, buildRecommendationContent } from './progress-manager.js';
import { renderTranslationTitle, getFileIcon, createGenericEPUBIcon } from './progress-title.js';
import { LifecycleManager } from '../utils/lifecycle-manager.js';
import { t } from '../i18n/i18n.js';

// Storage configuration with versioning
const STORAGE_VERSION = 1;
const STORAGE_KEY_PREFIX = 'tbl_translation_state';
const TRANSLATION_STATE_STORAGE_KEY = `${STORAGE_KEY_PREFIX}_v${STORAGE_VERSION}`;

/**
 * Validate translation state structure
 * @param {any} data - Data to validate
 * @returns {boolean} True if valid
 */
function validateTranslationState(data) {
    if (!data || typeof data !== 'object') return false;

    // Check required fields
    if (!('version' in data)) return false;
    if (!('currentJob' in data)) return false;
    if (!('isBatchActive' in data)) return false;
    if (!('activeJobs' in data)) return false;
    if (!('hasActive' in data)) return false;

    // Validate types
    if (typeof data.isBatchActive !== 'boolean') return false;
    if (typeof data.hasActive !== 'boolean') return false;
    if (!Array.isArray(data.activeJobs)) return false;

    // Validate currentJob if present
    if (data.currentJob !== null) {
        if (typeof data.currentJob !== 'object') return false;
        if (!('translationId' in data.currentJob)) return false;
        if (!('fileRef' in data.currentJob)) return false;
    }

    return true;
}

function isActiveTranslationSummary(job) {
    if (!job) return false;
    return job.status === 'running'
        || job.status === 'queued'
        || (job.status === 'rate_limited' && job.auto_resume_pending);
}

export const TranslationTracker = {
    // Debounce timer for saving state
    _saveStateTimer: null,
    _saveStateDebounceMs: 100,

    /**
     * Initialize translation tracker
     */
    async initialize() {
        // Clean up old storage versions
        this.cleanupOldStorageVersions();

        // Setup event listeners FIRST (they need to be ready before any state changes)
        this.setupEventListeners();

        // CRITICAL: Check server session BEFORE restoring state
        // This prevents restoring state from a previous server session
        try {
            const serverWasRestarted = await LifecycleManager.getServerSessionCheck();

            if (serverWasRestarted) {
                this.initializeDefaultTranslationState();
            } else {
                this.restoreTranslationStateSync();

                await Promise.all([
                    this.updateActiveTranslationsState(),
                    this.reconcileStateWithServer()
                ]);
            }
        } catch (error) {
            console.error('Failed to initialize translation state:', error);
            MessageLogger.addLog(t('translation:session_init_failed'));

            // Fallback: restore from localStorage anyway
            this.restoreTranslationStateSync();
        }

        // Mark initialization as complete
        this._initializationComplete = true;
    },

    /**
     * Check if initialization is complete
     * @returns {boolean} True if initialization is complete
     */
    isInitialized() {
        return this._initializationComplete === true;
    },

    /**
     * Clean up old localStorage versions
     */
    cleanupOldStorageVersions() {
        try {
            // Remove old non-versioned key
            const oldKey = 'tbl_translation_state';
            if (localStorage.getItem(oldKey)) {
                localStorage.removeItem(oldKey);
            }

            // Remove any other versions (future-proofing)
            for (let i = 0; i < STORAGE_VERSION; i++) {
                const oldVersionKey = `${STORAGE_KEY_PREFIX}_v${i}`;
                if (localStorage.getItem(oldVersionKey)) {
                    localStorage.removeItem(oldVersionKey);
                }
            }
        } catch (error) {
            console.warn('Failed to cleanup old storage versions:', error);
        }
    },

    /**
     * Restore translation state from localStorage synchronously
     * This ensures the UI shows the translation state immediately on page load
     */
    restoreTranslationStateSync() {
        try {
            const stored = localStorage.getItem(TRANSLATION_STATE_STORAGE_KEY);

            if (!stored) {
                this.initializeDefaultTranslationState();
                return;
            }

            const savedState = JSON.parse(stored);

            if (!validateTranslationState(savedState)) {
                MessageLogger.addLog(t('translation:session_corrupted_log'));
                this.initializeDefaultTranslationState();
                this.clearTranslationState();
                return;
            }

            if (savedState.version !== STORAGE_VERSION) {
                this.initializeDefaultTranslationState();
                this.clearTranslationState();
                return;
            }

            if (savedState.isBatchActive && savedState.currentJob) {
                StateManager.setState('translation.currentJob', savedState.currentJob);
                StateManager.setState('translation.isBatchActive', savedState.isBatchActive);
                StateManager.setState('translation.activeJobs', savedState.activeJobs || []);
                StateManager.setState('translation.hasActive', savedState.hasActive || false);

                DomHelpers.show('progressSection');
                DomHelpers.show('interruptBtn');

                const translateBtn = DomHelpers.getElement('translateBtn');
                if (translateBtn) {
                    translateBtn.disabled = true;
                    translateBtn.innerHTML = t('translation:batch_in_progress');
                }

                MessageLogger.addLog(t('translation:session_restored_log'));
            } else {
                this.initializeDefaultTranslationState();
            }
        } catch (error) {
            console.error('Failed to restore translation state from localStorage:', error);
            MessageLogger.addLog(t('translation:session_could_not_restore'));
            this.initializeDefaultTranslationState();
        }
    },

    /**
     * Reconcile local state with server state
     * Checks if localStorage state matches server reality
     */
    async reconcileStateWithServer() {
        try {
            const currentJob = StateManager.getState('translation.currentJob');

            // If we have a local job, verify it exists on server
            if (currentJob && currentJob.translationId) {
                try {
                    const serverState = await ApiClient.getTranslationStatus(currentJob.translationId);

                    if (serverState.status === 'completed' ||
                        serverState.status === 'error' ||
                        serverState.status === 'interrupted' ||
                        (serverState.status === 'rate_limited' && !serverState.auto_resume_pending)) {

                        MessageLogger.addLog(t('translation:session_sync_log', { status: serverState.status }));
                        this.resetUIToIdle();
                    } else if (serverState.status === 'running' || serverState.status === 'queued') {
                        // Calculate progress from stats if available
                        if (serverState.stats) {
                            this.updateStats(currentJob.fileRef.fileType, serverState.stats);
                        }
                    }
                } catch (error) {
                    if (error.status === 404) {
                        MessageLogger.addLog(t('translation:session_job_missing_log'));
                        this.resetUIToIdle();
                    }
                }
            }

            await this.restoreActiveTranslation();

        } catch (error) {
            console.warn('Failed to reconcile state with server:', error);
        }
    },

    /**
     * Initialize default translation state (when no saved state exists)
     */
    initializeDefaultTranslationState() {
        StateManager.setState('translation.currentJob', null);
        StateManager.setState('translation.isBatchActive', false);
        StateManager.setState('translation.activeJobs', []);
        StateManager.setState('translation.hasActive', false);
    },

    /**
     * Save translation state to localStorage (debounced)
     */
    saveTranslationState() {
        // Clear existing timer
        if (this._saveStateTimer) {
            clearTimeout(this._saveStateTimer);
        }

        // Debounce to avoid multiple rapid saves
        this._saveStateTimer = setTimeout(() => {
            this._performSaveTranslationState();
        }, this._saveStateDebounceMs);
    },

    /**
     * Perform the actual save to localStorage
     * @private
     */
    _performSaveTranslationState() {
        try {
            const state = {
                version: STORAGE_VERSION,
                currentJob: StateManager.getState('translation.currentJob'),
                isBatchActive: StateManager.getState('translation.isBatchActive'),
                activeJobs: StateManager.getState('translation.activeJobs'),
                hasActive: StateManager.getState('translation.hasActive'),
                timestamp: Date.now()
            };

            localStorage.setItem(TRANSLATION_STATE_STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            console.error('Failed to save translation state to localStorage:', error);

            // Check if it's a quota exceeded error
            if (error.name === 'QuotaExceededError') {
                MessageLogger.addLog(t('translation:session_state_save_quota'));
            } else {
                MessageLogger.addLog(t('translation:session_state_save_failed'));
            }
        }
    },

    /**
     * Clear translation state from localStorage
     */
    clearTranslationState() {
        try {
            // Clear any pending save
            if (this._saveStateTimer) {
                clearTimeout(this._saveStateTimer);
                this._saveStateTimer = null;
            }

            localStorage.removeItem(TRANSLATION_STATE_STORAGE_KEY);
        } catch (error) {
            console.error('Failed to clear translation state from localStorage:', error);
        }
    },

    /**
     * Restore active translation state if there's one running on the server
     */
    async restoreActiveTranslation() {
        try {
            const response = await ApiClient.getActiveTranslations();
            const activeJobs = (response.translations || []).filter(isActiveTranslationSummary);

            if (activeJobs.length === 0) return;

            StateManager.setState('translation.isBatchActive', true);

            // Find matching file in our queue
            const filesToProcess = StateManager.getState('files.toProcess') || [];

            for (const job of activeJobs) {
                let matchingFile = filesToProcess.find(f =>
                    f.translationId === job.translation_id ||
                    f.filePath === job.input_file ||
                    f.name === job.input_file?.split('/').pop()
                );

                // If no matching file found, create a virtual file reference from server data
                if (!matchingFile && job.input_filename) {
                    matchingFile = {
                        name: job.input_filename,
                        translationId: job.translation_id,
                        status: 'Processing',
                        fileType: job.file_type || 'txt',
                        type: job.file_type || 'txt',
                        isVirtual: true
                    };
                }

                if (matchingFile) {
                    // Set current context for DomHelpers
                    window.currentActiveTranslationId = job.translation_id;
                    
                    this.ensureJobUIContainer(job.translation_id, matchingFile);
                    this.updateTranslationTitle(matchingFile);

                    // Calculate progress from stats
                    if (job.total_chunks > 0) {
                        const stats = {
                            total_chunks: job.total_chunks,
                            completed_chunks: job.completed_chunks || 0,
                            failed_chunks: job.failed_chunks || 0,
                            elapsed_time: job.elapsed_time,
                            progress_percent: job.progress_percent,
                            current_phase: job.current_phase,
                            enable_refinement: job.enable_refinement || false
                        };
                        this.updateStats(matchingFile.fileType || matchingFile.type, stats);
                    }

                    if (job.last_translation) {
                        MessageLogger.updateTranslationPreview(job.last_translation);
                    }

                    const translateBtn = DomHelpers.getElement('translateBtn');
                    if (translateBtn) {
                        translateBtn.disabled = true;
                        translateBtn.innerHTML = t('translation:batch_in_progress');
                    }
                    DomHelpers.show('interruptBtn');

                    if (!matchingFile.isVirtual) {
                        this.updateFileStatusInList(matchingFile.name, 'Processing', job.translation_id);
                    }
                    
                    window.currentActiveTranslationId = null;
                }
            }
        } catch (error) {
            console.warn('Failed to restore active translation:', error);
        }
    },

    setupEventListeners() {
        StateManager.subscribe('translation.currentJob', () => {
            this.saveTranslationState();
        });

        StateManager.subscribe('translation.isBatchActive', () => {
            this.saveTranslationState();
        });

        StateManager.subscribe('translation.hasActive', () => {
            this.updateResumeButtonsState();
            this.saveTranslationState();
        });

        StateManager.subscribe('translation.activeJobs', () => {
            this.saveTranslationState();
        });

        if (!this._jobInterruptHandlerAttached) {
            document.addEventListener('click', (event) => {
                const target = event.target instanceof Element
                    ? event.target
                    : event.target?.parentElement;
                const button = target?.closest('.job-interrupt-btn');
                if (!button) return;
                event.preventDefault();
                this.interruptJob(button.dataset.translationId, button);
            });
            this._jobInterruptHandlerAttached = true;
        }
    },

    async interruptJob(translationId, button = null) {
        if (!translationId) {
            MessageLogger.showMessage(t('translation:no_active_translation'), 'info');
            return false;
        }

        const activeJobs = StateManager.getState('translation.activeJobs') || [];
        const job = activeJobs.find(item => item.translation_id === translationId);
        const displayName = job?.output_filename || job?.input_filename || translationId;
        const label = button?.querySelector('.job-interrupt-label');

        if (button) {
            button.disabled = true;
        }
        if (label) {
            label.textContent = t('translation:interrupting');
        }

        try {
            await ApiClient.interruptTranslation(translationId);
            MessageLogger.showMessage(
                t('translation:interrupt_task_request_sent', { name: displayName }),
                'info'
            );
            MessageLogger.addLog(t('translation:interrupt_task_log', { name: displayName }));
            return true;
        } catch (error) {
            MessageLogger.showMessage(
                t('translation:interrupt_task_error', { name: displayName, error: error.message }),
                'error'
            );
            if (button) {
                button.disabled = false;
            }
            if (label) {
                label.textContent = t('translation:interrupt_task');
            }
            return false;
        }
    },

    async interruptAllActiveJobs() {
        await this.updateActiveTranslationsState();
        const activeJobs = StateManager.getState('translation.activeJobs') || [];
        const ids = activeJobs
            .filter(isActiveTranslationSummary)
            .map(job => job.translation_id)
            .filter(Boolean);

        const currentJob = StateManager.getState('translation.currentJob');
        if (currentJob?.translationId && !ids.includes(currentJob.translationId)) {
            ids.push(currentJob.translationId);
        }

        if (ids.length === 0) {
            MessageLogger.showMessage(t('translation:no_active_translation'), 'info');
            return { requested: 0, failed: 0 };
        }

        StateManager.setState('translation.isBatchActive', false);
        const results = await Promise.allSettled(
            ids.map(translationId => ApiClient.interruptTranslation(translationId))
        );
        const failed = results.filter(result => result.status === 'rejected').length;

        if (failed === 0) {
            MessageLogger.showMessage(t('translation:interrupt_request_sent'), 'info');
            MessageLogger.addLog(t('translation:interrupt_all_log', { count: ids.length }));
        } else {
            MessageLogger.showMessage(
                t('translation:interrupt_all_error', { failed, count: ids.length }),
                'error'
            );
        }

        return { requested: ids.length, failed };
    },

    /**
     * Handle translation update from WebSocket
     * @param {Object} data - Translation update data
     */
    handleTranslationUpdate(data) {
        // Try to find the file from files to process or active jobs
        const filesToProcess = StateManager.getState('files.toProcess') || [];
        const activeJobs = StateManager.getState('translation.activeJobs') || [];
        
        let currentFile = filesToProcess.find(f => f.translationId === data.translation_id) || 
                          activeJobs.find(f => f.translation_id === data.translation_id);
                         
        // fallback
        if (!currentFile && data.translation_id) {
            currentFile = {
                name: data.output_filename || data.translation_id,
                translationId: data.translation_id,
                status: data.status,
                type: 'unknown',
                isVirtual: true
            };
        }
        if (currentFile) {
            currentFile.name = currentFile.name
                || currentFile.input_filename
                || currentFile.output_filename
                || data.translation_id;
            currentFile.translationId = currentFile.translationId
                || currentFile.translation_id
                || data.translation_id;
            currentFile.fileType = currentFile.fileType
                || currentFile.file_type
                || currentFile.type;
        }

        // Set global context for DomHelpers
        window.currentActiveTranslationId = data.translation_id;
        
        // Ensure DOM exists
        this.ensureJobUIContainer(data.translation_id, currentFile);

        if (data.log) {
            MessageLogger.addLog(`[${currentFile.name || currentFile.output_filename}] ${data.log}`);
        }

        // Progress is now calculated from stats in ProgressManager.update()
        // No need to call updateProgress() separately
        if (data.stats) {
            this.updateStats(currentFile.fileType || currentFile.type, data.stats);
        }

        if (data.log_entry
            && (data.log_entry.type === 'llm_response' || data.log_entry.type === 'refinement_response')
            && data.log_entry.data && data.log_entry.data.response) {
            MessageLogger.updateTranslationPreview(data.log_entry.data.response);
        }

        if (data.status === 'completed') {
            MessageLogger.resetProgressTracking();
            this.finishFileTranslation(
                t('translation:translation_completed_msg', { name: currentFile.name }),
                'success',
                currentFile,
                data
            );
            this.updateActiveTranslationsState();
            this.removeJobUIContainer(data.translation_id);
        } else if (data.status === 'interrupted') {
            MessageLogger.resetProgressTracking();
            this.finishFileTranslation(
                t('translation:translation_interrupted_msg', { name: currentFile.name }),
                'info',
                currentFile,
                data
            );
            this.updateActiveTranslationsState();
            this.removeJobUIContainer(data.translation_id);
        } else if (data.status === 'rate_limited' && data.auto_resume_pending) {
            MessageLogger.showMessage(
                t('translation:translation_rate_limited_auto_resume_msg', {
                    name: currentFile.name,
                    seconds: data.backoff_seconds || data.rate_limit_backoff_seconds || 0
                }),
                'info'
            );
            this.updateFileStatusInList(currentFile.name, 'Rate Limited');
            this.updateActiveTranslationsState();
        } else if (data.status === 'rate_limited') {
            MessageLogger.resetProgressTracking();
            this.finishFileTranslation(
                t('translation:translation_rate_limited_msg', { name: currentFile.name }),
                'info',
                currentFile,
                data
            );
            this.updateActiveTranslationsState();
            this.removeJobUIContainer(data.translation_id);
        } else if (data.status === 'error') {
            MessageLogger.resetProgressTracking();
            this.finishFileTranslation(
                t('translation:translation_error_msg', { name: currentFile.name, error: data.error || t('translation:translation_unknown_error') }),
                'error',
                currentFile,
                data
            );
            this.updateActiveTranslationsState();
            this.removeJobUIContainer(data.translation_id);
        } else if (data.status === 'running') {
            MessageLogger.resetProgressTracking();

            // Only show progress section specific to this job
            const containerId = `job_progress_${data.translation_id}`;
            const container = document.getElementById(containerId);
            if (container) {
                container.style.display = 'block';
            }

            // Re-render rich title for this specific job
            this.updateTranslationTitle(currentFile);

            this.resetOpenRouterCostDisplay();

            MessageLogger.showMessage(t('translation:translation_in_progress', { name: currentFile.name }), 'info');
            this.updateFileStatusInList(currentFile.name, 'Processing');
        }
        
        window.currentActiveTranslationId = null;
    },

    /**
     * Ensure the UI container for a job exists
     */
    ensureJobUIContainer(translationId, fileRef) {
        const containerId = `job_progress_${translationId}`;
        const existing = document.getElementById(containerId);
        if (existing) return;

        const activeJobsContainer = document.getElementById('activeJobsContainer');
        const template = document.getElementById('progressSectionTemplate');
        if (!activeJobsContainer || !template) return;

        // Ensure template is clean before cloning
        MessageLogger.resetTranslationPreview();

        // Clone template
        const clone = template.cloneNode(true);
        clone.id = containerId;
        clone.classList.remove('hidden');
        clone.style.display = 'block';

        // Update all IDs inside the clone to have _translationId suffix
        const elementsWithId = clone.querySelectorAll('[id]');
        elementsWithId.forEach(el => {
            el.id = `${el.id}_${translationId}`;
        });

        // Set the filename and styling
        const titleEl = clone.querySelector('.job-filename');
        if (titleEl && fileRef) {
            titleEl.textContent = fileRef.name || fileRef.output_filename || translationId;
        }

        activeJobsContainer.prepend(clone);
    },

    /**
     * Remove the UI container for a job
     */
    removeJobUIContainer(translationId) {
        const container = document.getElementById(`job_progress_${translationId}`);
        if (container) {
            container.remove();
        }
    },

    /**
     * Update translation title with file icon/thumbnail and name
     * @param {Object} file - File object
     */
    updateTranslationTitle(file) {
        renderTranslationTitle(file);
    },

    /**
     * Update statistics display
     * @param {string} fileType - File type (txt, epub, srt)
     * @param {Object} stats - Statistics object
     */
    updateStats(fileType, stats) {
        ProgressManager.update({ stats: stats }, fileType);
        this.updateOpenRouterCost(stats);
    },

    /**
     * Update OpenRouter cost display
     * @param {Object} stats - Statistics object containing cost data
     */
    updateOpenRouterCost(stats) {
        const costGrid = DomHelpers.getElement('openrouterCostGrid');
        if (!costGrid) return;

        const cost = stats.openrouter_cost || 0;
        const promptTokens = stats.openrouter_prompt_tokens || 0;
        const completionTokens = stats.openrouter_completion_tokens || 0;
        const totalTokens = promptTokens + completionTokens;

        // Show cost grid if there's any cost or token data
        if (cost > 0 || totalTokens > 0) {
            DomHelpers.show('openrouterCostGrid');
            DomHelpers.setText('openrouterCost', '$' + cost.toFixed(4));
            DomHelpers.setText('openrouterTokens', totalTokens.toLocaleString());
        }
    },

    /**
     * Reset OpenRouter cost display for a new translation
     */
    resetOpenRouterCostDisplay() {
        DomHelpers.hide('openrouterCostGrid');
        DomHelpers.setText('openrouterCost', '$0.0000');
        DomHelpers.setText('openrouterTokens', '0');
    },

    /**
     * Update file status in UI list
     * @param {string} fileName - File name
     * @param {string} newStatus - New status text
     * @param {string} [translationId] - Translation ID
     */
    updateFileStatusInList(fileName, newStatus, translationId = null) {
        const fileListItem = DomHelpers.getOne(`#fileListContainer li[data-filename="${fileName}"] .file-status`);
        if (fileListItem) {
            DomHelpers.setText(fileListItem, `(${newStatus})`);
        }

        // Update in state
        const filesToProcess = StateManager.getState('files.toProcess');
        const fileObj = filesToProcess.find(f => f.name === fileName);
        if (fileObj) {
            fileObj.status = newStatus;
            if (translationId) {
                fileObj.translationId = translationId;
            }
            StateManager.setState('files.toProcess', filesToProcess);
            // Persist to localStorage
            FileUpload.notifyFileListChanged();
        }
    },

    /**
     * Finish a specific file translation and update UI
     * @param {string} statusMessage - Status message to display
     * @param {string} messageType - Message type (success, error, info)
     * @param {Object} fileRef - The file reference being finished
     * @param {Object} resultData - Translation result data
     */
    finishFileTranslation(statusMessage, messageType, fileRef, resultData) {
        if (!fileRef) return;

        fileRef.status = resultData.status || 'unknown_error';
        fileRef.result = resultData.result;

        MessageLogger.showMessage(statusMessage, messageType);
        this.updateFileStatusInList(
            fileRef.name,
            resultData.status === 'completed' ? 'Completed' :
            resultData.status === 'interrupted' ? 'Interrupted' :
            resultData.status === 'rate_limited' ? 'Rate Limited' : 'Error'
        );

        if (resultData.status === 'completed') {
            this.renderCompletionCard(fileRef, resultData);
        }

        // If this was the 'focused' currentJob, clear it
        const currentJob = StateManager.getState('translation.currentJob');
        if (currentJob && currentJob.translationId === resultData.translation_id) {
            StateManager.setState('translation.currentJob', null);
        }

        const batchStillActive = StateManager.getState('translation.isBatchActive');

        if (resultData.status === 'completed') {
            if (batchStillActive) {
                this.processNextFileInQueue();
            }
        } else if (resultData.status === 'interrupted') {
            MessageLogger.addLog(t('translation:task_paused_log', { name: fileRef.name }));
            if (batchStillActive) {
                this.processNextFileInQueue();
            }
            setTimeout(() => {
                const active = StateManager.getState('translation.activeJobs') || [];
                if (active.length === 0) this.resetUIToIdle();
            }, 500);
        } else if (resultData.status === 'rate_limited') {
            MessageLogger.addLog(t('translation:batch_paused_log'));
            // Pause current batch flow but let others continue
        } else {
            // On error, still try to move to next
            if (batchStillActive) {
                this.processNextFileInQueue();
            }
        }
    },

    /**
     * Render a persistent success card for a completed file, with quick actions
     * to locate it on disk.
     * @param {Object} file - The file that just finished
     * @param {Object} resultData - Final payload from the server (output_filename, output_dir)
     */
    renderCompletionCard(file, resultData) {
        const container = DomHelpers.getElement('completionCardsContainer');
        if (!container) return;

        const card = document.createElement('div');
        card.className = 'completion-card';
        this._populateCompletionCard(card, file, resultData);
        container.appendChild(card);
        this._ensureCompletionCardsLocaleListener();
    },

    /**
     * Fill (or rebuild) an existing completion card with localized content.
     * Pulled out of `renderCompletionCard` so the same DOM tree can be
     * re-rendered on `localeChanged` without dropping the card from the page.
     *
     * Stashes the source payload on the element itself so the locale listener
     * can rebuild without coordinating extra storage.
     */
    _populateCompletionCard(card, file, resultData) {
        card._tblPayload = { file, resultData };

        const outputFilename = resultData.output_filename || file.outputFilename || file.name;
        const safeFilename = DomHelpers.escapeHtml(outputFilename);
        const statsHtml = this._buildCompletionStatsHtml(file, resultData);
        const dismissLabel = t('translation:completion_card_dismiss');

        card.innerHTML = '';

        const topRow = document.createElement('div');
        topRow.className = 'completion-card__top';
        topRow.appendChild(this._buildCompletionThumb(file));

        const main = document.createElement('div');
        main.className = 'completion-card__main';
        main.innerHTML = `
            <div class="completion-card__header">
                <h3 class="completion-card__title">
                    <span class="material-symbols-outlined">check_circle</span>
                    <span>${t('translation:translation_completed_card_title')}${statsHtml}</span>
                </h3>
                <button type="button" class="completion-card__close" title="${dismissLabel}" aria-label="${dismissLabel}">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="completion-card__filename" title="${safeFilename}">${safeFilename}</div>
        `;
        topRow.appendChild(main);
        card.appendChild(topRow);

        const warningBlock = this._buildCompletionWarningBlock(file, resultData);
        if (warningBlock) {
            card.appendChild(warningBlock);
        }

        const actionsGroup = FileActions.createActionGroup({
            actions: ['download', 'open', 'reveal', 'files-tab'],
            filename: outputFilename,
            variant: 'labeled'
        });
        actionsGroup.classList.add('completion-card__actions');
        card.appendChild(actionsGroup);

        card.querySelector('.completion-card__close').addEventListener('click', () => card.remove());
    },

    /**
     * Re-render every visible completion card whenever the user switches
     * locale, so the dynamically interpolated strings (title, stat badges,
     * warning block, action labels) stay in sync with the rest of the UI.
     * Bound once, lazily, the first time a card is rendered.
     */
    _ensureCompletionCardsLocaleListener() {
        if (this._completionLocaleListenerBound) return;
        this._completionLocaleListenerBound = true;
        window.addEventListener('localeChanged', () => {
            const container = DomHelpers.getElement('completionCardsContainer');
            if (!container) return;
            container.querySelectorAll('.completion-card').forEach((card) => {
                if (card._tblPayload) {
                    this._populateCompletionCard(card, card._tblPayload.file, card._tblPayload.resultData);
                }
            });
        });
    },

    /**
     * Build the thumbnail element for the completion card.
     * Uses the book cover for EPUBs (with SVG fallback), generic icon otherwise.
     * @param {Object} file - File object (fileType, thumbnail)
     * @returns {HTMLElement} Thumb wrapper element
     */
    _buildCompletionThumb(file) {
        const wrap = document.createElement('div');
        wrap.className = 'completion-card__thumb';

        if (file.fileType === 'epub' && file.thumbnail) {
            const img = document.createElement('img');
            img.src = `/api/thumbnails/${encodeURIComponent(file.thumbnail)}`;
            img.alt = 'Cover';
            img.onerror = () => {
                wrap.innerHTML = createGenericEPUBIcon();
            };
            wrap.appendChild(img);
        } else {
            wrap.innerHTML = getFileIcon(file.fileType);
        }

        return wrap;
    },

    /**
     * Build the stats block HTML for the completion card.
     * @param {Object} file - File object (for fileType)
     * @param {Object} resultData - Final payload (contains stats)
     * @returns {string} HTML for the stats block (empty string if no stats)
     */
    _buildCompletionStatsHtml(file, resultData) {
        const stats = resultData.stats || {};

        const failed = stats.failed_chunks || 0;
        const elapsed = stats.elapsed_time;
        const fallbacks = (file && file.fileType === 'srt')
            ? 0
            : (stats.token_alignment_used || 0) + (stats.fallback_used || 0);
        const placeholderErrors = (file && file.fileType === 'srt')
            ? 0
            : (stats.placeholder_errors || 0);

        const cost = stats.openrouter_cost || 0;
        const promptTokens = stats.openrouter_prompt_tokens || 0;
        const completionTokens = stats.openrouter_completion_tokens || 0;
        const totalTokens = promptTokens + completionTokens;

        const items = [];

        if (typeof elapsed === 'number' && elapsed > 0) {
            items.push(formatElapsedTime(elapsed));
        }

        if (failed > 0) {
            items.push(`<span class="completion-card__stat--error">${t('translation:completion_failed_chunks', { count: failed })}</span>`);
        }

        if (fallbacks > 0) {
            items.push(`<span class="completion-card__stat--warn">${t('translation:completion_fallback_chunks', { count: fallbacks })}</span>`);
        }

        if (placeholderErrors > 0) {
            items.push(`<span class="completion-card__stat--warn">${t('translation:completion_placeholder_errors', { count: placeholderErrors })}</span>`);
        }

        if (cost > 0 || totalTokens > 0) {
            items.push(`$${cost.toFixed(4)} · ${totalTokens.toLocaleString()} tokens`);
        }

        if (items.length === 0) return '';

        return `<span class="completion-card__stats"> - ${items.join(' · ')}</span>`;
    },

    /**
     * Build the warning block surfaced beneath the title when the run produced
     * fallbacks, placeholder errors, or failed chunks. Mirrors the live
     * recommendation panel from progress-manager so the post-translation
     * advice stays in sync with what was shown during the run.
     *
     * @param {Object} file - File object (used to gate by file type)
     * @param {Object} resultData - Final payload (contains stats)
     * @returns {HTMLElement|null} Warning block element, or null when there is
     *   nothing worth surfacing.
     */
    _buildCompletionWarningBlock(file, resultData) {
        const stats = resultData.stats || {};
        if (file && file.fileType === 'srt') {
            return null;
        }

        const fallbacks = (stats.token_alignment_used || 0) + (stats.fallback_used || 0);
        const placeholderErrors = stats.placeholder_errors || 0;
        const failed = stats.failed_chunks || 0;
        const tokenAlignment = stats.token_alignment_used || 0;
        const untranslated = stats.fallback_used || 0;

        if (fallbacks === 0 && placeholderErrors === 0 && failed === 0) {
            return null;
        }

        const block = document.createElement('div');
        block.className = 'completion-card__warning';

        const heading = document.createElement('div');
        heading.className = 'completion-card__warning-heading';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        icon.textContent = 'warning';
        heading.appendChild(icon);
        const headingText = document.createElement('span');
        headingText.textContent = t('translation:completion_warning_heading');
        heading.appendChild(headingText);
        block.appendChild(heading);

        const breakdownItems = [];
        if (tokenAlignment > 0) {
            breakdownItems.push(t('translation:completion_warning_token_alignment', { count: tokenAlignment }));
        }
        if (untranslated > 0) {
            breakdownItems.push(t('translation:completion_warning_untranslated', { count: untranslated }));
        }
        if (placeholderErrors > 0) {
            breakdownItems.push(t('translation:completion_warning_placeholder_errors', { count: placeholderErrors }));
        }
        if (failed > 0) {
            breakdownItems.push(t('translation:completion_warning_failed', { count: failed }));
        }
        if (breakdownItems.length > 0) {
            const breakdown = document.createElement('div');
            breakdown.className = 'completion-card__warning-breakdown';
            breakdown.textContent = breakdownItems.join(' · ');
            block.appendChild(breakdown);
        }

        // Only renew the rate-based recommendations when there were actual
        // fallbacks or placeholder issues — a run with only `failed_chunks`
        // (e.g. provider errors) is not really a "tune the LLM" situation.
        if (fallbacks > 0 || placeholderErrors > 0) {
            const recommendations = document.createElement('div');
            recommendations.className = 'completion-card__warning-recommendations';
            buildRecommendationContent(
                recommendations,
                deriveRateContext(stats),
                'translation:completion_warning_intro',
            );
            block.appendChild(recommendations);
        }

        return block;
    },

    /**
     * Remove all completion cards. Currently unused — cards are dismissed
     * individually by the user via the card's close button.
     */
    clearCompletionCards() {
        const container = DomHelpers.getElement('completionCardsContainer');
        if (container) container.innerHTML = '';
    },

    /**
     * Process next file in queue (delegates to batch-controller when available)
     */
    processNextFileInQueue() {
        // Trigger event for batch controller to handle
        window.dispatchEvent(new CustomEvent('processNextFile'));
    },

    /**
     * Check and update active translations state
     */
    async updateActiveTranslationsState() {
        try {
            const response = await ApiClient.getActiveTranslations();
            const activeJobs = (response.translations || []).filter(isActiveTranslationSummary);

            const wasActive = StateManager.getState('translation.hasActive');
            const hasActive = activeJobs.length > 0;

            StateManager.setState('translation.hasActive', hasActive);
            StateManager.setState('translation.activeJobs', activeJobs);

            // If state changed, update UI
            if (wasActive !== hasActive) {
                this.updateResumeButtonsState();
            }

            return { hasActive, activeJobs };
        } catch {
            return {
                hasActive: StateManager.getState('translation.hasActive'),
                activeJobs: StateManager.getState('translation.activeJobs')
            };
        }
    },

    /**
     * Update the state of all resume buttons based on active translations
     */
    updateResumeButtonsState() {
        const resumeButtons = DomHelpers.getElements('button[onclick^="resumeJob"]');
        const activeJobs = StateManager.getState('translation.activeJobs') || [];
        const isMaxActive = activeJobs.length >= 5;

        resumeButtons.forEach(button => {
            if (isMaxActive) {
                button.disabled = true;
                button.style.opacity = '0.5';
                button.style.cursor = 'not-allowed';
                button.title = t('translation:cannot_resume_in_progress_title');
            } else {
                button.disabled = false;
                button.style.opacity = '1';
                button.style.cursor = 'pointer';
                button.title = t('translation:resume_btn_title');
            }
        });

        // Update warning banner
        this.updateResumableJobsWarningBanner();
    },

    /**
     * Update or create the warning banner in resumable jobs section
     */
    updateResumableJobsWarningBanner() {
        const listContainer = DomHelpers.getElement('resumableJobsList');
        if (!listContainer) return;

        const existingBanner = listContainer.querySelector('.active-translation-warning');
        const activeJobs = StateManager.getState('translation.activeJobs') || [];
        const isMaxActive = activeJobs.length >= 5;

        if (isMaxActive) {
            const activeNames = activeJobs.map(job => job.output_filename || t('translation:job_card_unknown')).join(', ');
            const bannerHtml = `
                <div class="active-translation-warning" style="background: #fef3c7; border: 1px solid #f59e0b; padding: 12px; margin-bottom: 15px; border-radius: 6px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">⚠️</span>
                        <div style="flex: 1;">
                            <strong style="color: #92400e;">${t('translation:active_translation_warning_title')}</strong>
                            <p style="margin: 5px 0 0 0; font-size: 13px; color: #78350f;">
                                Maximum concurrent translations (5) reached. Resume disabled. Active: ${DomHelpers.escapeHtml(activeNames)}
                            </p>
                        </div>
                    </div>
                </div>
            `;

            if (existingBanner) {
                existingBanner.outerHTML = bannerHtml;
            } else {
                // Insert at the beginning of the container
                listContainer.insertAdjacentHTML('afterbegin', bannerHtml);
            }
        } else if (existingBanner) {
            // Remove banner if max active translations not reached
            existingBanner.remove();
        }
    },

    resetUIToIdle() {
        StateManager.setState('translation.isBatchActive', false);
        StateManager.setState('translation.currentJob', null);

        this.clearTranslationState();

        DomHelpers.hide('interruptBtn');
        DomHelpers.setDisabled('interruptBtn', false);
        DomHelpers.setText('interruptBtn', t('translation:interrupt_batch_with_icon'));

        const filesToProcess = StateManager.getState('files.toProcess');
        DomHelpers.setDisabled('translateBtn', filesToProcess.length === 0 || !StatusManager.isConnected());
        DomHelpers.setText('translateBtn', t('translation:start_batch_with_icon'));

        if (filesToProcess.length === 0) {
            const activeJobsContainer = document.getElementById('activeJobsContainer');
            if (activeJobsContainer) {
                activeJobsContainer.innerHTML = '';
            }
        }

        this.updateActiveTranslationsState();

        if (window.loadResumableJobs) {
            window.loadResumableJobs();
        }
    }
};

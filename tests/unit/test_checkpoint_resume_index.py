"""Resume-index convention + backward-compat for load_checkpoint.

New checkpoints carry the 'resume_index_semantics' = 'completed' marker, so
current_chunk_index is the last completed unit for every format and resume is
always +1. Pre-migration checkpoints (no marker) must still resume correctly
via the legacy per-format branch (EPUB stored file_idx+1, TXT/SRT stored the
last completed chunk).
"""

import json

import pytest

from src.persistence.checkpoint_manager import CheckpointManager


@pytest.fixture
def cm(tmp_path):
    return CheckpointManager(db_path=str(tmp_path / "jobs.db"))


def _set_progress(manager, translation_id, progress):
    conn = manager.db._get_connection()
    conn.execute(
        "UPDATE translation_jobs SET progress = ? WHERE translation_id = ?",
        (json.dumps(progress), translation_id),
    )
    conn.commit()


@pytest.mark.parametrize("file_type", ["epub", "txt", "srt"])
def test_new_marked_checkpoint_resumes_at_next_unit(cm, file_type):
    cm.start_job("job", file_type, {}, None)
    # New convention: store the last completed unit index.
    cm.save_checkpoint(
        translation_id="job",
        chunk_index=2,
        original_text="x",
        translated_text="y",
        total_chunks=10,
        completed_chunks=3,
        failed_chunks=0,
    )
    assert cm.load_checkpoint("job")["resume_from_index"] == 3


def test_legacy_epub_checkpoint_without_marker(cm):
    # Pre-migration EPUB: current_chunk_index was file_idx+1 (the next file),
    # and there is no semantics marker.
    cm.start_job("job", "epub", {}, None)
    _set_progress(cm, "job", {
        "current_chunk_index": 3,  # = file_idx(2) + 1 under the old convention
        "total_chunks": 10,
        "completed_chunks": 3,
        "failed_chunks": 0,
    })
    # Legacy branch: EPUB must NOT add +1, so it resumes at file 3.
    assert cm.load_checkpoint("job")["resume_from_index"] == 3


def test_legacy_txt_checkpoint_without_marker(cm):
    cm.start_job("job", "txt", {}, None)
    _set_progress(cm, "job", {
        "current_chunk_index": 5,  # last completed chunk under the old convention
        "total_chunks": 10,
        "completed_chunks": 6,
        "failed_chunks": 0,
    })
    # Legacy branch: TXT adds +1.
    assert cm.load_checkpoint("job")["resume_from_index"] == 6

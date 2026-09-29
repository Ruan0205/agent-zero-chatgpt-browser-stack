# Safe memory removal

Memory similarity is useful for retrieval, not authority for deletion. The
tool-execution hook changes memory_forget to literal content selection, requires
reviewed confirm_ids for multiple matches and supports dry_run previews. An
exact memory_delete ID never cascades into neighboring records. Both operations
checkpoint the complete FAISS store before deletion in a private directory.

The system-prompt hook applies to all models and describes the supported args.
This guard covers agent tool dispatch, not every internal automatic-memory or
administrative API operation. Test on an isolated database, never real user
memories. Tests: python -m unittest discover -s tests -p test_scope.py.

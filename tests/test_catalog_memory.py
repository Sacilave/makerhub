from app.services import catalog, three_mf


def test_release_catalog_memory_clears_large_process_caches():
    catalog._ARCHIVE_SNAPSHOT_CACHE.update(
        snapshot={"models": [{"id": "model-1"}]},
        dirty=False,
        dirty_reason="",
        built_at=123.0,
        marker_token="marker",
    )
    catalog._MODEL_DETAIL_CACHE["model-1"] = {"payload": {"large": True}}
    catalog._SUBSCRIPTION_FLAGS_INDEX_CACHE.update(
        signature=("marker", 1),
        deleted_by_key={"model-1": True},
    )
    catalog._DECORATED_MODELS_CACHE.update(
        signature=("marker", 1),
        all_models=({"id": "model-1"},),
        visible_models=({"id": "model-1"},),
    )
    three_mf._INSPECT_CACHE["/archive/model-1/instances/model.3mf"] = {
        "signature": (1, 1),
        "payload": {"model_title": "model-1"},
    }

    catalog.release_catalog_memory()

    assert catalog._ARCHIVE_SNAPSHOT_CACHE["snapshot"] is None
    assert catalog._ARCHIVE_SNAPSHOT_CACHE["dirty"] is True
    assert catalog._MODEL_DETAIL_CACHE == {}
    assert catalog._SUBSCRIPTION_FLAGS_INDEX_CACHE["deleted_by_key"] == {}
    assert catalog._DECORATED_MODELS_CACHE["all_models"] == ()
    assert catalog._DECORATED_MODELS_CACHE["visible_models"] == ()
    assert not three_mf._INSPECT_CACHE

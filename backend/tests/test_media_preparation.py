"""Reference extraction must remain browser-decodable and transactional."""
import cv2
import numpy as np
import pytest
from scripts.prepare_reference_clip import clip_video
from scripts.evaluate import evaluate


def test_reference_is_h264_with_exact_window_and_preserves_output_on_failure(tmp_path):
    source = tmp_path / "source.mp4"
    writer = cv2.VideoWriter(str(source), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 48))
    for index in range(20):
        writer.write(np.full((48, 64, 3), index * 10, np.uint8))
    writer.release()
    output = tmp_path / "reference.mp4"
    assert clip_video(source, output, 500, 1500) == (10, 1500)
    check = cv2.VideoCapture(str(output))
    try:
        code = int(check.get(cv2.CAP_PROP_FOURCC))
        assert code.to_bytes(4, "little") in {b"avc1", b"h264"}
        assert int(check.get(cv2.CAP_PROP_FRAME_COUNT)) == 10
        ok, frame = check.read()
        assert ok and abs(float(frame.mean()) - 50) < 5
    finally:
        check.release()
    previous = output.read_bytes()
    with pytest.raises(ValueError, match="source is only"):
        clip_video(source, output, 0, 4000)
    assert output.read_bytes() == previous
    assert set(tmp_path.glob("*.mp4")) == {source, output}


def test_evaluation_rejects_cases_without_actual_labels(tmp_path):
    import json
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"cases": [{"id": "empty", "label_source": "human",
                                          "expected_phases_ms": {}, "expected_metrics": {}}]}))
    with pytest.raises(ValueError, match="actual annotation"):
        evaluate(path)

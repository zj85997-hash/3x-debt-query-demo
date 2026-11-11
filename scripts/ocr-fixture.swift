import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
    fatalError("Pass a rasterized copy of the synthetic fixture.")
}
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(url: source)
try handler.perform([request])
let recognized = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
let compact = recognized.joined().replacingOccurrences(of: " ", with: "")
let markers = ["DEMO-FIX-001", "DEMO-FIX-002", "DEMO-FIX-003", "DEMO-FIX-004", "DEMO-FIX-005"]
let recovered = markers.filter { compact.contains($0) }
let output: [String: Any] = [
    "sample": "虚构 PDF 页面栅格化",
    "recognizedLines": recognized.count,
    "referenceMarkers": recovered.count,
    "expectedMarkers": markers.count,
    "foundSampleName": compact.contains("样例甲"),
    "foundLeadingZeroSuffix": compact.contains("0067")
]
print(String(decoding: try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted,.sortedKeys]), as: UTF8.self))

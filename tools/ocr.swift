import Foundation
import Vision
import PDFKit
// usage: ocr <pdf> <firstPage> <lastPage>   (1-based) -> prints JSON lines {page, lines:[...]}
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
let first = Int(a[2])!, last = min(Int(a[3])!, doc.pageCount)
for p in first...last {
  guard let page = doc.page(at: p - 1) else { continue }
  let box = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2000 / max(box.width, box.height)
  let img = page.thumbnail(of: CGSize(width: box.width * scale, height: box.height * scale), for: .mediaBox)
  guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = ["ar-SA"]
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg).perform([req])
  let obs = (req.results ?? []).sorted { $0.boundingBox.maxY > $1.boundingBox.maxY }
  let lines = obs.compactMap { o -> [String: Any]? in
    guard let t = o.topCandidates(1).first?.string else { return nil }
    let b = o.boundingBox
    return ["t": t, "x": Double(b.minX), "y": Double(b.maxY)]
  }
  let data = try! JSONSerialization.data(withJSONObject: ["page": p, "lines": lines])
  print(String(data: data, encoding: .utf8)!)
  fflush(stdout)
}

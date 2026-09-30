import Foundation
import PDFKit
import AppKit
// usage: render <pdf> <outDir> <height> <jpegQuality>
// Writes <outDir>/<page>.jpg for every page (1-based), skipping pages already rendered.
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
let out = a[2], height = CGFloat(Double(a[3])!), quality = Double(a[4])!
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for i in 0..<doc.pageCount {
  let path = "\(out)/\(i + 1).jpg"
  if FileManager.default.fileExists(atPath: path) { continue }
  guard let page = doc.page(at: i) else { continue }
  let box = page.bounds(for: .mediaBox)
  let size = CGSize(width: (box.width * height / box.height).rounded(), height: height)
  let img = page.thumbnail(of: size, for: .mediaBox)
  guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { continue }
  try? jpg.write(to: URL(fileURLWithPath: path))
}

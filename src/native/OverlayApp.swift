import Cocoa
import SceneKit
import QuartzCore

// MARK: - Stdin JSON Commands
struct AnnotateCommand: Codable {
    let cmd: String
    let x: Double?
    let y: Double?
    let label: String?
    let offTrack: Bool?
    let color: String?  // hex color e.g. "#FF5733"
}

// MARK: - Hex Color Parsing
func colorFromHex(_ hex: String) -> NSColor? {
    var hexStr = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if hexStr.hasPrefix("#") { hexStr.removeFirst() }
    guard hexStr.count == 6 else { return nil }
    var rgbValue: UInt64 = 0
    Scanner(string: hexStr).scanHexInt64(&rgbValue)
    return NSColor(
        red: CGFloat((rgbValue >> 16) & 0xFF) / 255.0,
        green: CGFloat((rgbValue >> 8) & 0xFF) / 255.0,
        blue: CGFloat(rgbValue & 0xFF) / 255.0,
        alpha: 1.0
    )
}

// MARK: - Overlay Window Controller
class OverlayController: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var sceneView: SCNView!
    var scene: SCNScene!
    var cameraNode: SCNNode!
    var annotationGroup: SCNNode?
    let screenHeight: CGFloat

    override init() {
        let mainScreen = NSScreen.main!
        self.screenHeight = mainScreen.frame.size.height
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let mainScreen = NSScreen.main!
        let frame = mainScreen.frame

        // Create transparent fullscreen window
        window = NSWindow(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.level = .screenSaver
        window.backgroundColor = .clear
        window.isOpaque = false
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.hasShadow = false

        // Create SceneKit view
        sceneView = SCNView(frame: frame)
        sceneView.backgroundColor = .clear
        sceneView.allowsCameraControl = false
        sceneView.autoenablesDefaultLighting = false
        sceneView.isJitteringEnabled = false

        // Create scene
        scene = SCNScene()
        sceneView.scene = scene

        // Orthographic camera (1:1 mapping with screen points)
        cameraNode = SCNNode()
        let camera = SCNCamera()
        camera.usesOrthographicProjection = true
        camera.orthographicScale = Double(frame.height / 2)
        camera.zNear = 0.1
        camera.zFar = 1000
        cameraNode.camera = camera
        cameraNode.position = SCNVector3(Float(frame.width / 2), Float(frame.height / 2), 500)
        scene.rootNode.addChildNode(cameraNode)

        // Ambient light
        let lightNode = SCNNode()
        lightNode.light = SCNLight()
        lightNode.light?.type = .ambient
        lightNode.light?.color = NSColor.white
        scene.rootNode.addChildNode(lightNode)

        window.contentView = sceneView
        window.orderFrontRegardless()

        // Start reading stdin on background thread
        DispatchQueue.global(qos: .userInteractive).async {
            self.readStdin()
        }
    }

    // MARK: - Stdin Reader
    func readStdin() {
        let handle = FileHandle.standardInput
        var buffer = Data()

        while true {
            let data = handle.availableData
            if data.isEmpty {
                // EOF — parent process closed stdin
                DispatchQueue.main.async {
                    NSApplication.shared.terminate(nil)
                }
                return
            }

            buffer.append(data)

            // Process complete lines
            while let newlineRange = buffer.range(of: Data("\n".utf8)) {
                let lineData = buffer.subdata(in: buffer.startIndex..<newlineRange.lowerBound)
                buffer.removeSubrange(buffer.startIndex...newlineRange.lowerBound)

                guard let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespaces),
                      !line.isEmpty else { continue }

                if let cmdData = line.data(using: .utf8),
                   let cmd = try? JSONDecoder().decode(AnnotateCommand.self, from: cmdData) {
                    DispatchQueue.main.async {
                        self.handleCommand(cmd)
                    }
                }
            }
        }
    }

    // MARK: - Command Handler
    func handleCommand(_ cmd: AnnotateCommand) {
        switch cmd.cmd {
        case "annotate":
            guard let x = cmd.x, let y = cmd.y else { return }
            let label = cmd.label ?? ""
            let offTrack = cmd.offTrack ?? false
            let customColor = cmd.color.flatMap { colorFromHex($0) }
            showAnnotation(screenX: CGFloat(x), screenY: CGFloat(y), label: label, offTrack: offTrack, customColor: customColor)

        case "clear":
            clearAnnotation()

        case "quit":
            clearAnnotation()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                NSApplication.shared.terminate(nil)
            }

        default:
            break
        }
    }

    // MARK: - Annotation Rendering
    func showAnnotation(screenX: CGFloat, screenY: CGFloat, label: String, offTrack: Bool, customColor: NSColor? = nil) {
        // Convert screen coords (top-left origin) to SceneKit (bottom-left origin)
        let sceneX = Float(screenX)
        let sceneY = Float(screenHeight - screenY)
        let targetPos = SCNVector3(sceneX, sceneY, 0)

        let defaultBlue = NSColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1.0)
        let amberColor = NSColor(red: 0.96, green: 0.62, blue: 0.04, alpha: 1.0)
        // Off-track always uses amber; otherwise use custom color or default blue
        let color: NSColor = offTrack ? amberColor : (customColor ?? defaultBlue)

        // If existing annotation, fade out then create new
        if let existing = annotationGroup {
            SCNTransaction.begin()
            SCNTransaction.animationDuration = 0.15
            existing.opacity = 0
            SCNTransaction.completionBlock = {
                existing.removeFromParentNode()
                self.createAnnotationNodes(at: targetPos, color: color)
            }
            SCNTransaction.commit()
        } else {
            createAnnotationNodes(at: targetPos, color: color)
        }
    }

    func createAnnotationNodes(at target: SCNVector3, color: NSColor) {
        let group = SCNNode()
        group.position = SCNVector3(0, 0, 0)

        // --- Target Ring (SCNTorus) ---
        let ring = SCNTorus(ringRadius: 22, pipeRadius: 2)
        ring.firstMaterial?.diffuse.contents = color
        ring.firstMaterial?.emission.contents = color
        let ringNode = SCNNode(geometry: ring)
        ringNode.position = target
        ringNode.eulerAngles.x = .pi / 2 // Face the camera
        group.addChildNode(ringNode)

        // Pulse animation on ring
        let pulseUp = SCNAction.scale(to: 1.15, duration: 0.8)
        pulseUp.timingMode = .easeInEaseOut
        let pulseDown = SCNAction.scale(to: 0.95, duration: 0.8)
        pulseDown.timingMode = .easeInEaseOut
        ringNode.runAction(SCNAction.repeatForever(SCNAction.sequence([pulseUp, pulseDown])))

        // --- Inner Dot ---
        let dot = SCNSphere(radius: 5)
        dot.firstMaterial?.diffuse.contents = color
        dot.firstMaterial?.emission.contents = color
        let dotNode = SCNNode(geometry: dot)
        dotNode.position = target
        group.addChildNode(dotNode)

        // --- Spring entrance animation ---
        let startY = target.y + 100
        group.position.y = startY - target.y // Offset up
        group.opacity = 0

        scene.rootNode.addChildNode(group)
        annotationGroup = group

        SCNTransaction.begin()
        SCNTransaction.animationDuration = 0.5
        SCNTransaction.animationTimingFunction = CAMediaTimingFunction(controlPoints: 0.34, 1.56, 0.64, 1)
        group.position.y = 0
        group.opacity = 1
        SCNTransaction.commit()
    }

    func clearAnnotation() {
        if let existing = annotationGroup {
            SCNTransaction.begin()
            SCNTransaction.animationDuration = 0.2
            existing.opacity = 0
            SCNTransaction.completionBlock = {
                existing.removeFromParentNode()
            }
            SCNTransaction.commit()
            annotationGroup = nil
        }
    }
}

// MARK: - Main
let app = NSApplication.shared
let controller = OverlayController()
app.delegate = controller
app.setActivationPolicy(.accessory) // No dock icon
app.run()

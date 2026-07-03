/**
 * Functions for handling tools that can be used by clicking in the
 * OpenSeadragon viewport.
 * @namespace annotationTool
 */
const annotationTool = (function() {
    "use strict";

    // Tool for placing single-point markers
    const _markerTool = (function() {
        return {
            click: function(position) {
                const annotation = {
                    points: [{
                        x: position.x,
                        y: position.y
                    }],
                    z: position.z,
                    mclass: _activeMclass
                };
                annotationHandler.add(annotation, "viewport");
            },
            isEditing: () => false,
            resetIfYounger: (time) => {}
        };
    })();

    // Tool for adding a rectangle by clicking opposing corners
    const _rectTool = (function() {
        let _startPoint,
            _endPoint,
            _zLevel,
            _mclass,
            _clicks = 0, //Counting clicks to i) allow dblClick to behave like click, while ii) not starting new rectangle on dblClick-complete
            _birthTime;

        function _getAnnotation() {
            const points = [
                _startPoint,
                {x: _startPoint.x, y: _endPoint.y}, //Diagonal corner
                _endPoint,
                {x: _endPoint.x, y: _startPoint.y}
            ];
            const annotation = {
                points: points,
                z: _zLevel,
                mclass: _mclass
            };
            return annotation;
        }

        function _updatePending() {
            const annotation = _getAnnotation();
            layerHandler.topLayer().updatePendingRegion(annotation);
        }

        function reset() {
            _startPoint = null;
            _endPoint = null;
            layerHandler.topLayer().name === "region" && layerHandler.topLayer().updatePendingRegion(null);
            _clicks = 0;
        }

        function addPoint(position) {
            _clicks++;
            let coords = coordinateHelper.viewportToImage({
                x: position.x,
                y: position.y
            });
            _zLevel = position.z;
            _mclass = _activeMclass;
            _endPoint = coords;
            if (_startPoint) {
                if (_startPoint.x === coords.x && _startPoint.y === coords.y) {
                    console.info("Zero sized rectangle (double click?), ignoring click.");
                    return;
                }
                complete(position);
            }
            else {
                _startPoint = coords;
                _birthTime = Date.now();
                _updatePending();
            }
        }

        function complete(position) {
            _zLevel = position.z;
            _mclass = _activeMclass;
            if (_startPoint && _endPoint) {
                const annotation = _getAnnotation();
                annotationHandler.add(annotation, "image");
                reset();
            }
            else {
                console.warn("Complete called with incomplete rectangle!");
            }
        }

        return {
            click: addPoint,
            // Prevent starting a new rectangle by the two separate click events
            dblClick: function(position) {
                if (_clicks<2) { // only one click for this rect = new rect created from (half) dblClick-closing
                    console.info("Double-click close, reset to avoid creating new rectangle.");
                    reset();
                }
            },
            complete: addPoint,
            update: function(position) {
                if (_startPoint) {
                    _mclass = _activeMclass;
                    _endPoint = coordinateHelper.viewportToImage({
                        x: position.x,
                        y: position.y
                    });
                    _updatePending();
                }
            },
            revert: reset,
            reset: reset,
            isEditing: () => _startPoint != null,
            resetIfYounger: (time) => {
                if (Date.now()-_birthTime<time) reset();
            }
        };
    })();

    // Tool for adding a free-form polygon
    const _polyTool = (function() {
        let _points = [],
            _nextPoint,
            _zLevel,
            _mclass,
            _birthTime;

        function _getAnnotation(points) {
            return {
                points: points,
                z: _zLevel,
                mclass: _mclass
            };
        }

        function _updatePending() {
            const annotation = _getAnnotation([..._points, _nextPoint]);
            layerHandler.topLayer().updatePendingRegion(annotation);
        }

        function reset() {
            _points = [];
            _nextPoint = null;
            layerHandler.topLayer().name === "region" && layerHandler.topLayer().updatePendingRegion(null);
        }

        let recentTap=false; // Avoid double-tap creating two vertices
        function addPoint(position) {
            if (event.pointerType === 'touch') {
                if (recentTap) return;
                recentTap=true;
                setTimeout(() => recentTap=false, 200); // If two taps within 200ms, don't make 2nd point
            }
            _nextPoint = coordinateHelper.viewportToImage({
                x: position.x,
                y: position.y
            });
            _zLevel = position.z;
            _mclass = _activeMclass;
            const last = _points.pop();
            if (!last) {
                _birthTime = Date.now();
            }
            if (last && (last.x !== _nextPoint.x || last.y !== _nextPoint.y))
                _points.push(last);
            if (mathUtils.pathIntersectsSelf([..._points, _nextPoint], false))
                return;
            _points.push(_nextPoint);
            _updatePending();
        }

        function complete(position) {
            _zLevel = position.z;
            _mclass = _activeMclass;
            if (_points.length > 2 && !mathUtils.pathIntersectsSelf(_points)) {
                const annotation = _getAnnotation(_points);
                annotationHandler.add(annotation, "image");
                reset();
            }
        }

        return {
            click: addPoint,
            dblClick: complete,
            complete: complete,
            update: function(position) {
                if (_points.length) {
                    _mclass = _activeMclass;
                    _nextPoint = coordinateHelper.viewportToImage({
                        x: position.x,
                        y: position.y
                    });
                    _updatePending();
                }
            },
            revert: function() {
                _points.pop();
                _updatePending();
                if (!_points.length)
                    reset();
            },
            reset: reset,
            isEditing: () => _points.length !== 0,
            resetIfYounger: (time) => {
                if (Date.now()-_birthTime<time) reset();
            }
        };
    })();

    // Tool for adding a fixed-ratio rotated oval around a whole bark beetle.
    const _barkBeetleTool = (function() {
        const WIDTH_TO_HEIGHT_RATIO = 0.45;
        const ELLIPSE_SEGMENTS = 32;
        const MIN_AXIS_LENGTH = 3;
        const DRAG_COMPLETE_DISTANCE = 6;

        let _startPoint,
            _endPoint,
            _zLevel,
            _mclass,
            _birthTime,
            _dragging = false,
            _suppressNextClick = false;

        function _distance(a, b) {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            return Math.hypot(dx, dy);
        }

        function _viewportPositionToImage(position) {
            return coordinateHelper.viewportToImage({
                x: position.x,
                y: position.y
            });
        }

        function _getEllipsePoints(startPoint, endPoint) {
            const dx = endPoint.x - startPoint.x;
            const dy = endPoint.y - startPoint.y;
            const majorLength = Math.hypot(dx, dy);
            if (majorLength < MIN_AXIS_LENGTH) {
                return [];
            }

            const center = {
                x: (startPoint.x + endPoint.x) / 2,
                y: (startPoint.y + endPoint.y) / 2
            };
            const ux = dx / majorLength;
            const uy = dy / majorLength;
            const vx = -uy;
            const vy = ux;
            const majorRadius = majorLength / 2;
            const minorRadius = majorRadius * WIDTH_TO_HEIGHT_RATIO;
            const points = [];

            for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
                const angle = 2 * Math.PI * i / ELLIPSE_SEGMENTS;
                const majorOffset = Math.cos(angle) * majorRadius;
                const minorOffset = Math.sin(angle) * minorRadius;
                points.push({
                    x: center.x + ux * majorOffset + vx * minorOffset,
                    y: center.y + uy * majorOffset + vy * minorOffset
                });
            }
            return points;
        }

        function _getAnnotation() {
            return {
                points: _getEllipsePoints(_startPoint, _endPoint),
                z: _zLevel,
                mclass: _mclass
            };
        }

        function _updatePending() {
            if (!_startPoint || !_endPoint) {
                return;
            }
            const annotation = _getAnnotation();
            if (annotation.points.length > 2) {
                layerHandler.topLayer().updatePendingRegion(annotation);
            }
        }

        function reset() {
            _startPoint = null;
            _endPoint = null;
            _dragging = false;
            layerHandler.topLayer().name === "region" && layerHandler.topLayer().updatePendingRegion(null);
        }

        function _start(position, dragging=false) {
            _startPoint = _viewportPositionToImage(position);
            _endPoint = _startPoint;
            _zLevel = position.z;
            _mclass = _activeMclass;
            _birthTime = Date.now();
            _dragging = dragging;
        }

        function _setEnd(position) {
            if (!_startPoint) {
                return;
            }
            _endPoint = _viewportPositionToImage(position);
            _zLevel = position.z;
            _mclass = _activeMclass;
            _updatePending();
        }

        function complete(position) {
            _setEnd(position);
            if (!_startPoint || !_endPoint) {
                return;
            }
            if (_distance(_startPoint, _endPoint) < MIN_AXIS_LENGTH) {
                reset();
                return;
            }
            const annotation = _getAnnotation();
            if (annotation.points.length > 2 && !mathUtils.pathIntersectsSelf(annotation.points)) {
                annotationHandler.add(annotation, "image");
            }
            reset();
        }

        function click(position) {
            if (_suppressNextClick) {
                _suppressNextClick = false;
                return;
            }
            if (_startPoint) {
                complete(position);
            }
            else {
                _start(position);
                _updatePending();
            }
        }

        function press(position) {
            if (_startPoint) {
                return;
            }
            _start(position, true);
        }

        function release(position) {
            if (!_dragging || !_startPoint) {
                return;
            }
            const endPoint = _viewportPositionToImage(position);
            if (_distance(_startPoint, endPoint) >= DRAG_COMPLETE_DISTANCE) {
                _suppressNextClick = true;
                setTimeout(() => _suppressNextClick = false, 250);
                complete(position);
            }
            else {
                reset();
            }
        }

        return {
            click: click,
            press: press,
            release: release,
            dblClick: function() {},
            complete: complete,
            update: _setEnd,
            revert: reset,
            reset: reset,
            isEditing: () => _startPoint != null,
            resetIfYounger: (time) => {
                if (Date.now()-_birthTime<time) reset();
            }
        };
    })();

    const _tools = {
        marker: _markerTool,
        rect: _rectTool,
        poly: _polyTool,
        "bark-beetle": _barkBeetleTool
    };

    let _activeTool,
        _activeMclass,
        _lastPosition;

    function _callToolFunction(funName, position) {
        if (!_activeTool)
            return;
        if (position)
            _lastPosition = position;
        else
            position = _lastPosition;

        const fun = _activeTool[funName];
        if (fun)
            return fun(position);
    }

    function _replaceTool(newTool) {
        if (_activeTool && _activeTool !== newTool)
            reset();
        _activeTool = newTool;
    }

    /**
     * Set the currently active tool.
     * @param {string} toolName The name of the tool being used.
     */
    function setTool(toolName) {
        const tool = _tools[toolName];
        if (tool)
            _replaceTool(tool);
        else
            throw new Error("Invalid tool name.");
    }

    /**
     * Set the current marker class being assigned with the tool.
     * @param {string} mclass The currently active marker class.
     */
    function setMclass(mclass) {
        if (classUtils.getIDFromName(mclass) >= 0) {
            _activeMclass = mclass;
            _callToolFunction("update");
        }
        else
            throw new Error("Undefined marker class.");
    }

    /**
     * Perform a click in the viewport with the currently active tool.
     * @param {Object} position The position of the click.
     * @param {number} position.x The x coordinate in viewport coordinates.
     * @param {number} position.y The y coordinate in viewport coordinates.
     * @param {number} position.z The focus level.
     */
    function click(position) {
        _callToolFunction("click", position);
    }

    /**
     * Perform a double click in the viewport with the currently active tool.
     * @param {Object} position The position of the click.
     * @param {number} position.x The x coordinate in viewport coordinates.
     * @param {number} position.y The y coordinate in viewport coordinates.
     * @param {number} position.z The focus level.
     */
    function dblClick(position) {
        _callToolFunction("dblClick", position);
    }

    /**
     * Complete the currently active annotation.
     * @param {Object} position The position of the click.
     * @param {number} position.x The x coordinate in viewport coordinates.
     * @param {number} position.y The y coordinate in viewport coordinates.
     * @param {number} position.z The focus level.
     */
    function complete(position) {
        _callToolFunction("complete", position);
    }

    /**
     * Reset the currently used tool to an initial state.
     */
    function reset() {
        _callToolFunction("reset");
    }

    /**
     * Revert the last non-completing move made with the tool.
     */
    function revert() {
        _callToolFunction("revert");
    }

    /**
     * Let the active tool know that the mouse position has been updated
     * and carry out any appropriate actions.
     * @param {Object} position The position of the mouse.
     * @param {number} position.x The x coordinate in viewport coordinates.
     * @param {number} position.y The y coordinate in viewport coordinates.
     * @param {number} position.z The focus level.
     */
    function updateMousePosition(position) {
        _callToolFunction("update", position);
    }

    /**
     * Let tools react to a mouse press before click/drag handling.
     */
    function press(position) {
        _callToolFunction("press", position);
    }

    /**
     * Let tools react to a mouse release after optional dragging.
     */
    function release(position) {
        _callToolFunction("release", position);
    }

    function isEditing() {
        return _callToolFunction("isEditing");
    }

    //If object is less than time ms old, then reset it
    //Only valid for regions (since markers complete instantaneously)
    function resetIfYounger(time) {
        _activeTool && _activeTool["resetIfYounger"](time);
    }

    return {
        setTool,
        setMclass,
        click,
        dblClick,
        complete,
        reset,
        revert,
        updateMousePosition,
        press,
        release,
        isEditing,
        resetIfYounger
    };
})();
